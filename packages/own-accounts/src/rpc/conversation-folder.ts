export * as ConversationFolderRpc from "./conversation-folder.js"

import type { Deps } from "../deps.js"
import { ConversationFolders } from "../conversation-folder/folder.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: 기본 대화 폴더 (03 §5.1), 폴더 열기 시작 위치, the picker's listing and `새 폴더` (03 §18.3). The folder
 * conversations started without choosing a project work in, and where the folder picker starts, kept in the
 * own-accounts KV of the service that runs them; the folders the picker browses on that service's machine. Every
 * service answers for itself, an SSH host included (it decides its own folder), so these are not remote-managed.
 * Global methods at the control Location; stateless.
 */
export type Methods =
  | "conversationFolder.get"
  | "conversationFolder.set"
  | "conversationFolder.ensure"
  | "folderPicker.get"
  | "folderPicker.set"
  | "folderPicker.list"
  | "folderPicker.create"

export function handlers(deps: Deps): RpcTypes.Group<Methods> {
  const log = deps.log.child("conversation-folder")
  const answer = (
    result: ConversationFolders.Result,
    context: RpcTypes.Context<"conversationFolder.set" | "conversationFolder.ensure">,
  ) => {
    if (result.type === "refused")
      return context.error("conversation_folder_unavailable", `the folder cannot be used (${result.reason})`, {
        reason: result.reason,
        path: result.path,
      })
    if (result.changed) void deps.emitter.global("conversationFolder.changed", { folder: result.view })
    return result.view
  }
  return {
    "conversationFolder.get": () => ConversationFolders.view(deps),
    "conversationFolder.set": async (input, context) => {
      const result = await ConversationFolders.set(deps, input.path)
      log.info("conversation_folder_set", {
        custom: result.type === "ok" ? result.view.custom : undefined,
        refused: result.type === "refused" ? result.reason : undefined,
      })
      return answer(result, context)
    },
    "conversationFolder.ensure": async (_input, context) => {
      const result = await ConversationFolders.ensure(deps)
      if (result.type === "refused") log.warn("conversation_folder_unavailable", { reason: result.reason })
      if (result.type === "ok" && result.changed) log.info("conversation_folder_created", {})
      return answer(result, context)
    },
    "folderPicker.get": () => ConversationFolders.picker(deps),
    "folderPicker.set": async (input, context) => {
      const result = await ConversationFolders.setPicker(deps, input.start)
      if (result.type === "refused")
        return context.error("folder_picker_unavailable", `the folder cannot be the start (${result.reason})`, {
          reason: result.reason,
          path: result.path,
        })
      log.info("folder_picker_set", { custom: result.view.start !== null })
      void deps.emitter.global("folderPicker.changed", { picker: result.view })
      return result.view
    },
    "folderPicker.list": async (input, context) => {
      const result = await ConversationFolders.list(input.path)
      if (result.type === "ok") return result.view
      return context.error("folder_list_unavailable", `the folder cannot be listed (${result.reason})`, {
        reason: result.reason,
        path: result.path,
        ...(result.owner ? { owner: result.owner } : {}),
      })
    },
    "folderPicker.create": async (input, context) => {
      const result = await ConversationFolders.create(input)
      log.info("folder_created", { refused: result.type === "refused" ? result.reason : undefined })
      if (result.type === "ok") return result.view
      return context.error("folder_create_unavailable", `the folder was not made (${result.reason})`, {
        reason: result.reason,
        path: result.path,
      })
    },
  }
}
