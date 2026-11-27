export * as Browse from "./browse.js"

import os from "node:os"
import path from "node:path"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import type { MCPEditor } from "@opencode/plugin/promise/mcp"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import type { Mcp } from "@opencode/schema/mcp"
import type { Permission } from "@opencode/schema/permission"
import { OwnBrowse, type Approval } from "@own/protocol"
import { Store } from "@own/runtime"
import type { Deps } from "../deps.js"
import { Hooks } from "../hooks.js"
import { SessionApproval } from "../switching/approval.js"

/**
 * 내 브라우저 사용 (decisions BRW, `OwnBrowse`): OpenCode's Browse (`anomalyco/browse`, MIT) in own's conversations.
 *
 * - **The server.** While the setting is on and the `browse` program is found ({@link locate}), every Location of this
 *   PC but the control one gets the MCP server `browse` (`browse mcp`, stdio). Core then lists its tools as
 *   `browse_<tool>` and asks the permission of the same name for each call. An SSH host's service never folds it: the
 *   program and the browser are on this PC.
 * - **The per-conversation switch.** Core's default agent allows every action, so an MCP server's tools would run
 *   unasked in every approval mode. Every agent therefore carries `OwnBrowse.DENY` (registered again after each local
 *   `plugin.updated`, so it stays after the config's agents), which keeps the tools out of every catalog until
 *   `session.approval.set{browse: "on"}` writes `OwnBrowse.ALLOW` for one conversation. A `browse` server the user
 *   added some other way (`browse install` writes one into an OpenCode config) is gated the same way.
 * - **The approval mode** decides each call ({@link decide}, the `evaluate` hook, tighten only): `전체 허용` runs every
 *   call, `묻기` asks before an action and runs reads, `읽기 전용` refuses actions. A saved `항상 허용` of a tool
 *   counts. The read-only subagent roles never act (`presets/readonly.ts`).
 */

/** Model-facing reasons (core shows them with the refusal or on the ask card). */
export const MESSAGE = {
  readOnly:
    "This conversation is in read-only approval mode: actions in the user's real browser are refused. You may read pages (snapshot, screenshot) of tabs you were given; ask the user to change the mode for anything else.",
  ask: "An action in the user's real browser (their tabs and logins) asks first in this conversation.",
} as const

export async function register(deps: Deps) {
  const log = deps.log.child("browse")
  const hook = Hooks.guard(log)
  const store = file(deps)
  const here = deps.remote === undefined
  const state = {
    command: here ? await commandOf(await store.read().catch(() => EMPTY)) : undefined,
    agents: undefined as { dispose(): Promise<void> } | undefined,
    moving: Promise.resolve(),
    read: 0,
    stopped: false,
  }

  if (here)
    await deps.ctx.mcp.transform((editor) =>
      hook.sync("mcp.transform:browse", () => fold(editor, state.command, deps.location)),
    )
  const relocate = async () => {
    const previous = state.agents
    state.agents = await deps.ctx.agent.transform((editor) => hook.sync("agent.transform:browse", () => deny(editor)))
    await previous?.dispose()
  }
  await relocate()
  await deps.ctx.permission.hook("evaluate", (event) => hook.safe("browse.evaluate", () => evaluate(event), undefined))

  async function evaluate(event: PermissionEvaluation) {
    const tool = OwnBrowse.toolOf(event.action)
    if (tool === undefined || event.effect === "deny") return
    const kind = OwnBrowse.kind(tool, event.metadata?.input)
    if (kind === "read") return
    const info = await deps.ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined)
    // A conversation that cannot be read asks (fail closed).
    const mode = info ? SessionApproval.modeOf(info.permissions ?? [], []) : "ask"
    const next = decide({ kind, mode, effect: event.effect, saved: event.saved ?? [] })
    if (next === undefined) return
    event.effect = next.effect
    if (event.message === undefined || next.effect === "deny") event.message = next.message
  }

  const refresh = async () => {
    const current = ++state.read
    const command = await commandOf(await store.read())
    if (current !== state.read || state.stopped || command === state.command) return
    state.command = command
    log.info("browse_server_changed", { on: command !== undefined })
    await deps.ctx.mcp.reload()
  }
  const off = here
    ? deps.runtime.broadcast.on("browse.changed", () => {
        void refresh().catch((error: unknown) => log.error("browse_reload_failed", { error }))
      })
    : () => {}

  return {
    onEvent: (event: { readonly type: string }, meta: { readonly local: boolean }) => {
      if (event.type !== "plugin.updated" || !meta.local) return
      state.moving = state.moving
        .then(relocate)
        .catch((error: unknown) => log.error("browse_agents_register_failed", { error }))
    },
    stop: async () => {
      state.stopped = true
      off()
      await state.moving
      await state.agents?.dispose().catch((error: unknown) => log.debug("browse_agents_dispose_failed", { error }))
      state.agents = undefined
    },
  }
}

/**
 * The approval mode's decision for an action (a read is never changed), tighten only: `full` keeps core's answer,
 * `read-only` refuses, `ask` asks unless a saved `항상 허용` gives the allow, and a `custom` conversation (no own
 * bundle) keeps core's answer, which its own rules made.
 */
export function decide(input: {
  readonly kind: OwnBrowse.Kind
  readonly mode: Approval.Mode
  readonly effect: Permission.Effect
  readonly saved: ReadonlyArray<string>
}): { readonly effect: Permission.Effect; readonly message: string } | undefined {
  if (input.kind === "read" || input.effect === "deny") return undefined
  if (input.mode === "read-only") return { effect: "deny", message: MESSAGE.readOnly }
  if (input.mode !== "ask" || input.effect !== "allow") return undefined
  // Core saves an MCP tool's `항상 허용` for every resource (`save: ["*"]`).
  if (input.saved.some((resource) => resource === "*" || resource === "**")) return undefined
  return { effect: "ask", message: MESSAGE.ask }
}

/** The fold: the `browse` server in every Location of this PC but the control one, while there is a program. */
export function fold(
  editor: MCPEditor,
  command: string | undefined,
  location: { readonly directory: string; readonly control: boolean },
) {
  if (command === undefined || location.control) return
  editor.set(OwnBrowse.SERVER, server(command))
}

/**
 * `browse mcp`. OpenCode gets Browse's plain tools by its client name; `OPENCODE_BROWSER_TOOLS=plain` says so for any
 * relay it starts, so the permission names stay one per tool.
 */
export function server(command: string): Mcp.ServerConfig {
  return { type: "local", command: [command, "mcp"], environment: { OPENCODE_BROWSER_TOOLS: "plain" } }
}

/** Appends `OwnBrowse.DENY` to every agent once (an earlier copy is moved to the end). */
export function deny(editor: AgentEditor) {
  for (const agent of editor.list())
    editor.update(String(agent.id), (info) => {
      info.permissions = [...info.permissions.filter((rule) => !same(rule, OwnBrowse.DENY)), { ...OwnBrowse.DENY }]
    })
}

function same(a: Permission.Rule, b: Permission.Rule) {
  return a.action === b.action && a.resource === b.resource && a.effect === b.effect
}

export const EMPTY: OwnBrowse.File = { version: 1 }

/** `OWN_HOME\browse.json`; only the control Location writes it (`browse.set`). */
export function file(deps: Pick<Deps, "runtime">) {
  return new Store.JsonFile({ file: deps.runtime.layout.browse, schema: OwnBrowse.File, fallback: () => EMPTY })
}

/** The program a Location runs: found and the setting on, else none. */
async function commandOf(setting: OwnBrowse.Setting) {
  if (!OwnBrowse.enabled(setting)) return undefined
  return (await locate(setting)).command
}

/** What `browse.status` answers. `remote`: an SSH host's service, which never runs the program. */
export async function status(setting: OwnBrowse.Setting, remote: boolean, where?: Where): Promise<OwnBrowse.Status> {
  const found = await locate(setting, where)
  const enabled = OwnBrowse.enabled(setting)
  return {
    enabled,
    source: found.source,
    ...(found.command === undefined ? {} : { command: found.command }),
    given: Boolean(setting.command?.trim()),
    active: enabled && !remote && found.command !== undefined,
  }
}

/** Where to look: the user's home, the platform and PATH's lookup (tests give their own). */
export interface Where {
  readonly home: string
  readonly platform: NodeJS.Platform
  readonly which: (name: string) => string | null
}

const WHERE: Where = { home: os.homedir(), platform: process.platform, which: (name) => Bun.which(name) }

/**
 * The `browse` program: the absolute path the user gave (only that one, when given), else the install script's place
 * (`~/.local/bin/browse`, `browse.exe` on Windows), else PATH. On Windows only an `.exe` on PATH counts: a package
 * manager's `browse.cmd` shim cannot be started as an MCP server without a shell.
 */
export async function locate(
  setting: OwnBrowse.Setting,
  where: Where = WHERE,
): Promise<{ readonly source: OwnBrowse.Source; readonly command?: string }> {
  const given = setting.command?.trim()
  if (given)
    return path.isAbsolute(given) && (await exists(given))
      ? { source: "setting", command: given }
      : { source: "missing" }
  const windows = where.platform === "win32"
  const install = path.join(where.home, ".local", "bin", windows ? "browse.exe" : "browse")
  if (await exists(install)) return { source: "install", command: install }
  const found = where.which("browse")
  if (found && (!windows || found.toLowerCase().endsWith(".exe"))) return { source: "path", command: found }
  return { source: "missing" }
}

function exists(file: string) {
  return Bun.file(file)
    .stat()
    .then((info) => info.isFile())
    .catch(() => false)
}
