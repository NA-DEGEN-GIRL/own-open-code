export * as Registry from "./registry.js"

import type { OwnHarness } from "@own/protocol/rpc-harness"
import { DshShell } from "./dsh/shell.js"
import { DshTools } from "./dsh/tools.js"

/**
 * What a past tool call did, apart from the name and input shape one harness gives it (10 §3.7). Only these actions
 * translate between harnesses; any other call keeps its name and input.
 */
export type Action =
  | { readonly kind: "shell"; readonly command: string; readonly workdir?: string }
  | { readonly kind: "patch"; readonly patch: string }

export type Kind = Action["kind"]

/** One harness's tool for an action: its name, and reading and writing its input. */
export interface Form<K extends Kind> {
  readonly name: string
  /** The action of an input, or undefined when the input does not have this tool's shape. */
  readonly read: (input: unknown) => Extract<Action, { kind: K }> | undefined
  readonly write: (action: Extract<Action, { kind: K }>) => unknown
}

export interface Harness {
  readonly id: OwnHarness.HarnessID
  /** A harness without a tool for an action (pi has no patch tool) leaves such past calls under their own name. */
  readonly tools: { readonly shell: Form<"shell">; readonly patch?: Form<"patch"> }
  /** The harness's own tools, named in the switch notice when a session moves to it (notice.ts). */
  readonly listed?: ReadonlyArray<string>
}

/** Upstream's request unchanged: core's `shell{command, workdir?}` and `patch{patchText}`. */
export const opencode: Harness = {
  id: "opencode",
  tools: {
    shell: {
      name: "shell",
      read: (input) => shell(field(input, "command"), field(input, "workdir")),
      write: (action) => ({ command: action.command, ...(action.workdir === undefined ? {} : { workdir: action.workdir }) }),
    },
    patch: {
      name: "patch",
      read: (input) => patch(field(input, "patchText")),
      write: (action) => ({ patchText: action.patch }),
    },
  },
}

/**
 * Codex CLI's Direct tools: `exec_command{cmd, workdir?}` and `apply_patch`. `apply_patch` is a JSON `{input}` tool
 * until core sends freeform tools (P-019); a freeform call's input is the patch text itself, which `read` also takes.
 */
export const codex: Harness = {
  id: "codex",
  tools: {
    shell: {
      name: "exec_command",
      read: (input) => shell(field(input, "cmd"), field(input, "workdir")),
      write: (action) => ({ cmd: action.command, ...(action.workdir === undefined ? {} : { workdir: action.workdir }) }),
    },
    patch: {
      name: "apply_patch",
      read: (input) => patch(typeof input === "string" ? input : field(input, "input")),
      write: (action) => ({ input: action.patch }),
    },
  },
}

/**
 * The Pi coding agent's tools (src/pi/): `bash{command, timeout?}`, which has no working directory, so a shell call
 * made elsewhere in one reads `cd '<workdir>' && <command>`. Pi has no patch tool; past patch calls keep their name.
 */
export const pi: Harness = {
  id: "pi",
  tools: {
    shell: {
      name: "bash",
      read: (input) => shell(field(input, "command"), undefined),
      write: (action) => ({
        command:
          action.workdir === undefined
            ? action.command
            : `cd '${action.workdir.replaceAll("'", "'\\''")}' && ${action.command}`,
      }),
    },
  },
  listed: ["read", "bash", "edit", "write"],
}

/**
 * DeepSeek's deepseek-harness (src/dsh/): its shell tool is `pwsh{description, command, timeoutMs?, workdir?}` on
 * Windows and `bash{…}` elsewhere; dsh has no patch tool, so past patch calls keep their name, as for pi. A past call
 * gets no `description` (only the model that made a call could say what it does).
 */
export const dsh: Harness = {
  id: "dsh",
  tools: {
    shell: {
      name: DshShell.kind(),
      read: (input) => shell(field(input, "command"), field(input, "workdir")),
      write: (action) => ({
        command: action.command,
        ...(action.workdir === undefined ? {} : { workdir: action.workdir }),
      }),
    },
  },
  listed: DshTools.NAMES,
}

/**
 * oh-my-opencode through own-omo (15): core's tools under core's names, as `opencode` (omo's hooks see them under
 * OpenCode 1's names, which the model does not). Its own tools are own-omo's; without own-omo an `omo` session runs
 * exactly as `opencode`.
 */
export const omo: Harness = {
  id: "omo",
  tools: opencode.tools,
  listed: ["todowrite", "task", "background_output", "background_cancel", "call_omo_agent"],
}

/**
 * The `opencode` request on the Claude Agent provider, where the provider's Claude Code prompt stays in front: core's
 * tools under core's names. On any other provider it runs exactly as `opencode`.
 */
export const claudeCode: Harness = {
  id: "claude-code",
  tools: opencode.tools,
}

export const ALL: ReadonlyArray<Harness> = [opencode, codex, pi, dsh, omo, claudeCode]

export function get(id: OwnHarness.HarnessID) {
  if (id === "codex") return codex
  if (id === "pi") return pi
  if (id === "dsh") return dsh
  if (id === "omo") return omo
  if (id === "claude-code") return claudeCode
  return opencode
}

function field(input: unknown, key: string) {
  if (typeof input !== "object" || input === null || !(key in input)) return undefined
  // SAFETY: `key in input` holds, and the value is only compared by type below.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return (input as Record<string, unknown>)[key]
}

function shell(command: unknown, workdir: unknown): Extract<Action, { kind: "shell" }> | undefined {
  if (typeof command !== "string") return undefined
  return { kind: "shell", command, ...(typeof workdir === "string" ? { workdir } : {}) }
}

function patch(text: unknown): Extract<Action, { kind: "patch" }> | undefined {
  return typeof text === "string" ? { kind: "patch", patch: text } : undefined
}
