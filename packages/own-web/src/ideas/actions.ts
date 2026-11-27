// What a sticky can become (03 §4.4.1): the draft of a new conversation (never sent), a project note, or the clipboard.
import { Notes } from "@own/protocol/notes"
import { requestComposerRestore } from "@/attachments/intents"
import { LOCAL, type ServerRuntime } from "@/data"
import { titleOf, type Idea } from "./model"
import type { IdeasStore, RemoveOutcome } from "./store"

/**
 * `새 대화로 시작`: the idea goes into the new-session screen's draft (after what is there, never replacing it) and the
 * screen opens with the composer focused. Nothing is sent: the user reads it, adds to it and presses Enter.
 */
export function startConversation(text: string, navigate: () => void) {
  requestComposerRestore({ serverKey: LOCAL, sessionID: undefined, text, attachments: [], mode: "fill" })
  navigate()
  requestAnimationFrame(() => document.getElementById("own-composer-input")?.focus())
}

export type MoveOutcome =
  | { readonly type: "ok"; readonly removed: RemoveOutcome }
  | { readonly type: "error"; readonly message: string }

/**
 * `프로젝트 노트로 옮기기`: a new note in that folder's workspace notebook (own.accounts `notes.put`, the key every
 * client derives the same way, 02 §9.2), titled with the idea's first line; then the idea leaves the board. When the
 * note could not be written the idea stays where it is.
 */
export async function moveToProject(
  runtime: Pick<ServerRuntime, "rpc">,
  ideas: Pick<IdeasStore, "remove">,
  idea: Idea,
  directory: string,
): Promise<MoveOutcome> {
  const workspace = Notes.workspaceKey({ directory })
  if (!workspace) return { type: "error", message: directory }
  const written = await runtime.rpc
    .call("notes.put", {
      workspace,
      id: crypto.randomUUID(),
      title: titleOf(idea.text, Notes.TITLE_MAX),
      text: idea.text,
      baseRev: 0,
    })
    .then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
  if (written !== undefined) return { type: "error", message: written }
  return { type: "ok", removed: await ideas.remove(idea.id) }
}

/** `복사`: the idea's text on the clipboard; `false` where the page may not write it. */
export function copyText(text: string) {
  return (
    navigator.clipboard?.writeText(text).then(
      () => true,
      () => false,
    ) ?? Promise.resolve(false)
  )
}
