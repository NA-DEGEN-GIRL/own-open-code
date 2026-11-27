// Forking a session (03 §19.12, 02 §5.9(e)): `POST /api/session/:id/fork {before?}` copies the projected history
// (before a message, or all of it) into a new child session; the server also copies the session's permissions and
// metadata (core projector). own-web then clears the pin and archive flags (01 §17.1 #27) and hands the chosen
// message back to the new session's composer (`own:composer-restore`, text and attachments). The fork keeps the
// original's cache key (`model-request.ts:237`), so on the same account and model its prefix reads warm.
import type { SessionInfo, SessionUpdateInput } from "@opencode/client"
import { requestComposerRestore } from "@/attachments/intents"
import { draftFrom } from "@/attachments/model"
import type { ServerRuntime } from "@/data"
import { clearForkFlags, errorText } from "./model"

export type ForkOutcome =
  | { readonly ok: true; readonly session: SessionInfo }
  | { readonly ok: false; readonly reason: string }

export async function forkSession(input: {
  readonly runtime: Pick<ServerRuntime, "client" | "data">
  readonly serverKey: string
  readonly sessionID: string
  /** The user message the fork starts before; omitted copies the whole history. */
  readonly before?: string
}): Promise<ForkOutcome> {
  const runtime = input.runtime
  try {
    const forked = await runtime.client().session.fork({ sessionID: input.sessionID, before: input.before })
    runtime.data.session.remember(forked)
    const metadata = clearForkFlags(forked.metadata)
    if (metadata)
      await runtime
        .client()
        .session.update({ sessionID: forked.id, metadata: metadata as SessionUpdateInput["metadata"] })
        .catch((error: unknown) => console.error("[own-web] fork: clearing pin/archive failed", error))
    const message = input.before ? runtime.data.session.message.get(input.sessionID, input.before) : undefined
    if (message?.type === "user") {
      const draft = draftFrom(message)
      requestComposerRestore({
        serverKey: input.serverKey,
        sessionID: forked.id,
        text: draft.text,
        attachments: draft.attachments,
        mode: "replace",
      })
    }
    return { ok: true, session: forked }
  } catch (error) {
    console.error("[own-web] fork failed", error)
    return { ok: false, reason: errorText(error) ?? "unknown" }
  }
}
