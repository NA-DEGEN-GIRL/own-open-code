// Commands module entry (03 §18.13): the slash command catalog, the client command actions and the send path the
// composer uses (with src/mentions for the list and the chips). Owner: commands.
export { useCommandActions, type CommandActionOptions, type CommandActions, type CommandContext } from "./actions"
export {
  argumentHint,
  CLIENT_COMMANDS,
  clientCommand,
  hasArguments,
  parseSlash,
  type ClientCommand,
  type ClientCommandID,
} from "./catalog"
export { resolveClient, runClientCommand, sendComposed, type ClientInvocation, type SendResult } from "./run"
export { commandEn, commandKo, commandText, useCommandText, type CommandKey } from "./strings"
