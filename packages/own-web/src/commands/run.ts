// Sending what the composer holds (03 §18.12, §18.13): a client command runs here and never reaches the server as
// text; `/name args` of a server command goes to `POST /api/session/:id/command` with the mention parts; anything
// else is a prompt with the mention parts. Delivery (steer/queue) and the WAIT_SAFE/COMPACTING decisions stay with
// the composer's `planSend` (02 §5.3): this only performs the send it decided.
import type { SessionPromptInput } from "@opencode/client"
import { mentionParts } from "@/mentions/chips"
import type { MentionChip } from "@/mentions/types"
import type { CommandActions, CommandContext } from "./actions"
import { clientCommand, parseSlash, SERVER_FIRST, serverCommands, type ClientCommand } from "./catalog"

export interface ClientInvocation {
  readonly command: ClientCommand
  readonly args: string
}

/** A typed `/name` that the client handles, or `undefined` (prompt or server command). */
export function resolveClient(text: string, context: CommandContext): ClientInvocation | undefined {
  const parsed = parseSlash(text.trim())
  const command = parsed ? clientCommand(parsed.name) : undefined
  if (!parsed || !command) return undefined
  if (SERVER_FIRST.has(command.id)) {
    const server = serverCommands(context.runtime, context.directory)
    // Unknown catalog: let the send path load it and decide (`sendComposed`).
    if (!server || server.some((item) => item.name === parsed.name)) return undefined
  }
  return { command, args: parsed.args }
}

/**
 * Runs a client command. Returns text to put back into the composer when the command needs an argument that was
 * not given (`/agent`, `/skills` open their list), else `undefined`.
 */
export function runClientCommand(
  invocation: ClientInvocation,
  context: CommandContext,
  actions: CommandActions,
  addChip?: (chip: MentionChip) => void,
): string | undefined {
  const args = invocation.args
  switch (invocation.command.id) {
    case "new":
      return void actions.newSession(context)
    case "compact":
      return void actions.compact(context)
    case "reset-context":
      return void actions.resetContext(context, args)
    case "fork":
      return void actions.fork(context)
    case "undo":
      return void actions.undo(context)
    case "redo":
      return void actions.redo(context)
    case "export":
      return void actions.exportSession(context)
    case "btw":
      return void actions.sideQuestion(context, args)
    case "model":
      return void actions.openSwitcher(context)
    case "terminal":
      return void actions.openTab("terminal", context)
    case "review":
      return void actions.openTab("review", context)
    case "agent":
      if (!args) return "/agent "
      return void actions.switchAgent(context, args)
    case "skills": {
      const skill = args ? findSkill(context, args) : undefined
      if (!skill || !addChip) return "/skills "
      return void addChip({ kind: "skill", id: skill.id, name: skill.name })
    }
  }
}

export type SendResult = "prompt" | "command" | "client"

/** What the attachment store adds to a send (src/attachments `prepare`): inline media and the prompt metadata. */
export interface ComposedAttachments {
  readonly files: readonly { readonly uri: string; readonly name?: string }[]
  readonly metadata?: SessionPromptInput["metadata"]
}

/** Sends a prompt or a server command to an existing session. Throws when the server refuses. */
export async function sendComposed(input: {
  readonly context: CommandContext & { readonly sessionID: string }
  readonly text: string
  readonly chips: readonly MentionChip[]
  readonly delivery?: "steer" | "queue"
  readonly actions?: Pick<CommandActions, "openTab">
  /** Attachments of the composer (18.10), sent with the mention parts. */
  readonly attachments?: ComposedAttachments
}): Promise<SendResult> {
  const context = input.context
  const runtime = context.runtime
  const attached = input.attachments?.files ?? []
  const parsed = parseSlash(input.text.trim())
  const client = parsed ? clientCommand(parsed.name) : undefined
  if (parsed && (!client || SERVER_FIRST.has(client.id))) {
    const server = await loadServerCommands(context)
    const command = server?.find((item) => item.name === parsed.name)
    if (command) {
      const parts = mentionParts({ text: parsed.args, chips: input.chips, directory: context.directory, inline: false })
      await runtime.client().session.command({
        sessionID: context.sessionID,
        name: command.name,
        text: parts.text,
        files: [...(parts.files ?? []), ...attached],
        agents: parts.agents,
        skills: parts.skills,
        delivery: input.delivery,
      })
      if (client?.id === "review") input.actions?.openTab("review", context)
      return "command"
    }
    if (client) {
      input.actions?.openTab("review", context)
      return "client"
    }
  }
  const parts = mentionParts({ text: input.text, chips: input.chips, directory: context.directory })
  await runtime.data.session.prompt({
    sessionID: context.sessionID,
    ...parts,
    files: attached.length ? [...(parts.files ?? []), ...attached] : parts.files,
    metadata: input.attachments?.metadata,
    delivery: input.delivery,
  })
  return "prompt"
}

async function loadServerCommands(context: CommandContext) {
  const known = serverCommands(context.runtime, context.directory)
  if (known || !context.directory) return known
  await context.runtime.data.location.command.sync({ directory: context.directory }).catch((error: unknown) => {
    console.error("[own-web] command.list", error)
  })
  return serverCommands(context.runtime, context.directory)
}

function findSkill(context: CommandContext, name: string) {
  const skills = context.directory ? context.runtime.data.location.skill.list({ directory: context.directory }) : []
  const wanted = name.replace(/^@/, "").toLowerCase()
  return skills?.find((skill) => skill.id.toLowerCase() === wanted || skill.name.toLowerCase() === wanted)
}
