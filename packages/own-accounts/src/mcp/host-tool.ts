export * as McpHostTool from "./host-tool.js"

import type { AgentEditor } from "@opencode/plugin/promise/agent"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import type { Permission } from "@opencode/schema/permission"
import { Tool } from "@opencode/schema/tool"
import { Option, Schema } from "effect"
import { McpHost, type OwnMcp } from "@own/protocol"
import type { Deps } from "../deps.js"
import { Hooks } from "../hooks.js"
import type { RemoteHost } from "../remote/host.js"
import { SessionApproval } from "../switching/approval.js"
import { McpHostService } from "./host.js"

/**
 * `AI에게 설치 맡기기` (04 §13 "MCP", MH 2026-11-26): the host's tool `own_mcp_install`, through which the AI of an
 * install conversation writes the host's own MCP settings (own's normal route, never a settings file from the shell).
 *
 * - **Only in the job's conversation.** Every agent on a host carries the deny `{own_mcp_install, *, deny}` (registered
 *   again after each local `plugin.updated`, so it stays after the config's agents), which keeps the tool out of every
 *   catalog; own-web creates the install conversation with the allow in its own rules and the job in its metadata
 *   (`metadata.own.mcpInstall`: the PC's key, definition hash, name and value names). A conversation without a job
 *   cannot use it even if its rules allow it.
 * - **The approval mode decides the write** (the `evaluate` hook, tighten only): `전체 허용` writes, `묻기` asks first,
 *   `읽기 전용` refuses.
 * - **It writes what the PC defined**: the job's name and value names; the AI gives only the command, its arguments, a
 *   folder and plain variables (never a value of the PC: those come from the PC after the user sends them). It then
 *   runs the connection test and answers with its result, so the AI can finish with one line.
 */

const decodeJob = Schema.decodeUnknownOption(McpHost.Job)
const decodeInput = Schema.decodeUnknownOption(McpHost.ToolInput)

export const DENY: Permission.Rule = { action: McpHost.TOOL, resource: "*", effect: "deny" }
export const ALLOW: Permission.Rule = { action: McpHost.TOOL, resource: "*", effect: "allow" }

export const MESSAGE = {
  readOnly:
    "This conversation is in read-only approval mode: the MCP server is not registered. Ask the user to change the mode.",
  ask: "Registering an MCP server on this SSH host asks first in this conversation.",
  noJob:
    "This conversation is not an MCP install started from the PC (own Settings > MCP 서버 > AI에게 설치 맡기기), so it cannot register servers.",
} as const

export const DESCRIPTION = [
  "Registers the MCP server of this install conversation in this SSH host's own MCP settings, then runs its connection test and returns the result.",
  "Call it once the command works on this host (installed in user space). Give the command, its arguments and an optional working folder; `fixed` holds plain environment variables the command needs (never a secret: the server's secret values come from the PC separately, by name).",
  "Calling it again replaces the registration. Do not edit own or OpenCode settings files from the shell.",
].join("\n")

const INPUT = {
  type: "object",
  properties: {
    command: {
      type: "string",
      minLength: 1,
      description: "The program to run on this host (a name on PATH or an absolute path; `~/` is allowed).",
    },
    args: {
      type: "array",
      items: { type: "string" },
      description: "Its arguments; `${NAME}` names one of the server's values from the PC.",
    },
    cwd: { type: "string", minLength: 1, description: "Optional working folder (absolute or `~/…`)." },
    fixed: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Optional plain environment variables (not secrets), e.g. a cache folder.",
    },
  },
  required: ["command", "args"],
  additionalProperties: false,
} as const

export async function register(deps: Deps, mcp: RemoteHost.Mcp) {
  const log = deps.log.child("mcp-host-tool")
  const hook = Hooks.guard(log)
  const service = McpHostService.create(deps, mcp)
  const state = { agents: undefined as { dispose(): Promise<void> } | undefined, moving: Promise.resolve() }

  if (!deps.location.control)
    await deps.ctx.tool.transform((editor) =>
      hook.sync("tool.transform:mcp-install", () =>
        editor.add({
          name: McpHost.TOOL,
          description: DESCRIPTION,
          input: INPUT as unknown as Tool.ValueSchema,
          options: { codemode: false, permission: McpHost.TOOL },
          execute: (input: unknown, context: ToolContext) => run(input, context),
        }),
      ),
    )
  const relocate = async () => {
    const previous = state.agents
    state.agents = await deps.ctx.agent.transform((editor) =>
      hook.sync("agent.transform:mcp-install", () => deny(editor)),
    )
    await previous?.dispose()
  }
  await relocate()
  await deps.ctx.permission.hook("evaluate", (event) =>
    hook.safe("mcp-install.evaluate", () => evaluate(event), undefined),
  )

  async function evaluate(event: PermissionEvaluation) {
    if (event.action !== McpHost.TOOL || event.effect === "deny") return
    const info = await deps.ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined)
    // A conversation that cannot be read asks (fail closed).
    const mode = info ? SessionApproval.modeOf(info.permissions ?? [], []) : "ask"
    const next = decide(mode, event.effect)
    if (next === undefined) return
    event.effect = next.effect
    if (event.message === undefined || next.effect === "deny") event.message = next.message
  }

  async function run(raw: unknown, context: ToolContext): Promise<Tool.Result> {
    const input = Option.getOrUndefined(decodeInput(raw))
    if (!input) throw new Tool.Error({ message: "Give `command` (text) and `args` (a list of texts)." })
    const info = await deps.ctx.session.get({ sessionID: context.sessionID }).catch(() => undefined)
    const job = jobOf(info?.metadata)
    if (!job) throw new Tool.Error({ message: MESSAGE.noJob })
    const leaked = Object.keys(input.fixed ?? {}).find((name) => job.env.includes(name))
    if (leaked !== undefined)
      throw new Tool.Error({
        message: `${leaked} is one of the server's values from the PC; leave it out of \`fixed\` (the PC sends it by name).`,
      })
    await deps.ctx.permission.assert({
      sessionID: context.sessionID,
      agent: context.agent,
      action: McpHost.TOOL,
      resources: [job.name],
      save: [],
      metadata: { name: job.name, command: input.command, args: input.args },
      source: { type: "tool", messageID: context.messageID, id: context.id },
    })
    const existing = (await service.view()).servers.find(
      (server) => server.pc?.key === job.key || server.name === job.name,
    )
    const saved = await service.save({
      ...(existing ? { id: existing.id } : {}),
      name: job.name,
      transport: {
        type: "local",
        command: input.command,
        args: input.args,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        env: job.env,
        ...(job.codemode === undefined ? {} : { codemode: job.codemode }),
        ...(input.fixed === undefined || Object.keys(input.fixed).length === 0 ? {} : { fixed: input.fixed }),
      },
      pc: { key: job.key, hash: job.hash, at: deps.clock.now() },
    })
    if (!saved.ok)
      throw new Tool.Error({
        message: `The MCP server was not registered: ${saved.error.type} (${saved.error.message}).`,
      })
    const server = saved.value.servers.find((item) => item.name === job.name)!
    const tested = await service.test(server.id)
    log.info("mcp_install_tool", { name: job.name, ok: tested.ok && tested.value.ok })
    return { content: report(job, server, tested.ok ? tested.value : undefined) }
  }

  return {
    onEvent: (event: { readonly type: string }, meta: { readonly local: boolean }) => {
      if (event.type !== "plugin.updated" || !meta.local) return
      state.moving = state.moving
        .then(relocate)
        .catch((error: unknown) => log.error("mcp_install_agents_failed", { error }))
    },
    stop: async () => {
      await state.moving
      await state.agents?.dispose().catch((error: unknown) => log.debug("mcp_install_agents_dispose_failed", { error }))
      state.agents = undefined
    },
  }
}

/** The approval mode's decision for the write, tighten only (as 내 브라우저 사용's actions). */
export function decide(
  mode: ReturnType<typeof SessionApproval.modeOf>,
  effect: Permission.Effect,
): { readonly effect: Permission.Effect; readonly message: string } | undefined {
  if (effect === "deny") return undefined
  if (mode === "read-only") return { effect: "deny", message: MESSAGE.readOnly }
  if (mode === "ask" && effect === "allow") return { effect: "ask", message: MESSAGE.ask }
  return undefined
}

/** The job of an install conversation (`metadata.own.mcpInstall`), or none. */
export function jobOf(metadata: unknown): McpHost.Job | undefined {
  const own = isRecord(metadata) ? metadata.own : undefined
  const job = isRecord(own) ? own.mcpInstall : undefined
  return job === undefined ? undefined : Option.getOrUndefined(decodeJob(job))
}

/** Appends {@link DENY} to every agent once (an earlier copy is moved to the end). */
export function deny(editor: AgentEditor) {
  for (const agent of editor.list())
    editor.update(String(agent.id), (info) => {
      info.permissions = [
        ...info.permissions.filter(
          (rule) => !(rule.action === DENY.action && rule.resource === DENY.resource && rule.effect === DENY.effect),
        ),
        { ...DENY },
      ]
    })
}

function report(job: McpHost.Job, server: McpHost.Server, check: OwnMcp.Check | undefined) {
  const values =
    job.env.length === 0
      ? "It needs no values."
      : server.values === "ready"
        ? `Its values (${job.env.join(", ")}) came from the PC.`
        : `Its values (${job.env.join(", ")}) have not been sent from the PC yet: the server stays off until the user sends them (own Settings > MCP 서버 on the PC).`
  if (!check) return `Registered "${job.name}" on this host. The connection test could not run. ${values}`
  if (check.ok)
    return [
      `Registered "${job.name}" on this host. Connection test: OK${check.server ? ` (${check.server})` : ""}, ${check.tools.length} tool(s): ${check.tools
        .slice(0, 12)
        .map((tool) => tool.name)
        .join(", ")}.`,
      values,
    ].join("\n")
  return [
    `Registered "${job.name}" on this host. Connection test failed (${check.failure ?? "error"}${check.status ? ` ${check.status}` : ""}).`,
    check.error ? `What it said: ${check.error}` : "",
    values,
  ]
    .filter(Boolean)
    .join("\n")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
