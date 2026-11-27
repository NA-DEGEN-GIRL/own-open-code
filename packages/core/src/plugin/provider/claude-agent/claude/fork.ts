export * as ClaudeFork from "./fork.js"

// OWN-PATCH(P-045) begin
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk"
// OWN-PATCH(P-045) end
import { ClaudeSDK } from "./sdk.js"

export interface Result {
  readonly sessionID: string
  readonly messages: ReadonlyMap<string, string>
}

// The SDK gives forked messages fresh UUIDs. Verify the copied prefix before mapping checkpoints onto them.
export async function create(
  sessionID: string,
  messageID: string,
  // OWN-PATCH(P-045) begin
  folder?: { readonly dir: string; readonly sessionStore: SessionStore },
  // OWN-PATCH(P-045) end
): Promise<Result | undefined> {
  const { deleteSession, forkSession, getSessionMessages } = await ClaudeSDK.load()
  // OWN-PATCH(P-045) begin
  const source = await getSessionMessages(sessionID, folder)
  const end = source.findIndex((message) => message.uuid === messageID)
  if (end < 0) return
  const fork = await forkSession(sessionID, { ...folder, upToMessageId: messageID })
  try {
    const copied = await getSessionMessages(fork.sessionId, folder)
    // OWN-PATCH(P-045) end
    if (copied.length !== end + 1) throw new Error("Claude fork did not preserve the requested history boundary")
    const messages = new Map<string, string>()
    for (let i = 0; i < copied.length; i++) {
      const before = source[i]!
      const after = copied[i]!
      if (before.type !== after.type || JSON.stringify(before.message) !== JSON.stringify(after.message)) {
        throw new Error("Claude fork changed the copied conversation")
      }
      messages.set(before.uuid, after.uuid)
    }
    return { sessionID: fork.sessionId, messages }
  } catch (error) {
    // OWN-PATCH(P-045) begin
    await deleteSession(fork.sessionId, folder)
    // OWN-PATCH(P-045) end
    throw error
  }
}
