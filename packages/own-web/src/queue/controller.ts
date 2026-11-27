// Queue/steer actions of one session (03 §18.9): delivery toggle (`PATCH …/inbox/:id {delivery}`; steering wakes the
// session), `지금 보내기` (a queued prompt becomes a steer), `편집` (cancel, then the text and attachments go back into
// the composer; the server does not accept content edits; a main request without its envelope, 06 §5.2), `✕`
// (cancel), reorder of queued prompts (re-admit the changed suffix parked with its metadata, then cancel the
// originals; a failed re-admission withdraws the copies). One change at a time; rows lock while it runs. A pending
// steer's own actions in the transcript are `pendingSteerActions` (steer-actions.ts).
import { SessionMessage } from "@opencode/schema/session-message"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { createMemo, createSignal } from "solid-js"
import type { ServerRuntime } from "@/data"
import { draftFrom, readmitFiles } from "@/attachments/model"
import { requestComposerRestore } from "@/attachments/intents"
import { stateOf } from "@/switcher/pending-chip"
import { accountOf, targetAccount } from "@/switcher/labels"
import { currentRef } from "@/switcher/session"
import { messageSource, moveBy, queueRows, reorderPlan, type QueuedUser } from "./model"

export type QueueProblem = "failed" | "changed" | "reorderBlocked" | "revertBlocked"

export interface QueueInput {
  readonly runtime: () => ServerRuntime | undefined
  readonly serverKey: () => string
  readonly sessionID: () => string | undefined
  /** Messages the composer holds during a compact-then-switch (03 §6.5). */
  readonly held: () => readonly string[]
  readonly onProblem?: (problem: QueueProblem) => void
}

export type Queue = ReturnType<typeof createQueue>

export function createQueue(input: QueueInput) {
  const [working, setWorking] = createSignal(false)
  const pending = () => {
    const runtime = input.runtime()
    const id = input.sessionID()
    return runtime && id ? runtime.data.session.pending.list(id) : []
  }
  const rows = createMemo(() => {
    const runtime = input.runtime()
    const id = input.sessionID()
    if (!runtime || !id) return []
    const model = currentRef(runtime, id)
    const state = runtime.own.state.switchState[id]
    const waiting = stateOf(state, "WAIT_SAFE") ?? stateOf(state, "COMPACTING")
    return queueRows({
      pending: pending(),
      held: input.held(),
      busy: runtime.data.session.status(id) === "running",
      // The session's own account (SL-8: the Claude accounts share `anthropic`, so the provider names only the first);
      // a switch to Claude lands on the account its record names, not the binding's company (SL-17).
      current: model ? (accountOf(runtime, model.providerID, id)?.label ?? model.providerID) : "",
      pendingTarget: waiting
        ? (targetAccount(runtime, waiting.target.providerID, id, waiting.accountID)?.label ?? waiting.target.providerID)
        : undefined,
    })
  })
  const queued = () => rows().flatMap((row) => (row.kind === "user" && row.delivery === "queue" ? [row.id] : []))
  const revertStaged = () => {
    const runtime = input.runtime()
    const id = input.sessionID()
    return !!(runtime && id && runtime.data.session.get(id)?.revert)
  }
  const item = (inboxID: string) =>
    pending().find((entry): entry is QueuedUser => entry.type === "user" && entry.id === inboxID)

  /** Runs one change with the rows locked; reports failures and re-reads the inbox afterwards. */
  async function run(work: (runtime: ServerRuntime, sessionID: string) => Promise<unknown>) {
    const runtime = input.runtime()
    const sessionID = input.sessionID()
    if (!runtime || !sessionID || working()) return false
    setWorking(true)
    try {
      await work(runtime, sessionID)
      return true
    } catch (error) {
      console.error("[own-web] queue change failed", error)
      input.onProblem?.(error instanceof QueueChanged ? error.problem : "failed")
      runtime.data.session.pending.invalidate(sessionID)
      void runtime.data.session.pending.sync(sessionID).catch(() => undefined)
      return false
    } finally {
      setWorking(false)
    }
  }

  const setDelivery = (inboxID: string, delivery: "steer" | "queue") =>
    run((runtime, sessionID) => runtime.client().session.inbox.update({ sessionID, inboxID, delivery }))

  function toggle(inboxID: string) {
    const current = pending().find((entry) => entry.id === inboxID)
    if (!current || current.type !== "user") return Promise.resolve(false)
    return setDelivery(inboxID, current.delivery === "steer" ? "queue" : "steer")
  }

  /** `지금 보내기`: a queued prompt steers (delivered at the next safe step boundary; wakes an idle session). */
  const sendNow = (inboxID: string) => setDelivery(inboxID, "steer")

  const cancel = (inboxID: string) =>
    run((runtime, sessionID) => runtime.client().session.inbox.cancel({ sessionID, inboxID }))

  /**
   * `편집` (and Ctrl+↑ on the first row): cancel, then put the text and attachments back into the composer. A main
   * request goes back without its envelope; sent again, it is the user's own message (06 §5.2).
   */
  function edit(inboxID: string) {
    const entry = item(inboxID)
    if (!entry) return Promise.resolve(false)
    return run(async (runtime, sessionID) => {
      await runtime.client().session.inbox.cancel({ sessionID, inboxID })
      const draft = draftFrom(entry.payload)
      requestComposerRestore({
        serverKey: input.serverKey(),
        sessionID,
        text: messageSource(entry.payload.metadata) === "user" ? draft.text : OwnTeamText.unwrap(entry.payload.text),
        attachments: draft.attachments,
        mode: "fill",
      })
    })
  }

  function editFirst() {
    const first = rows().find((row) => row.kind === "user")
    if (!first || first.kind !== "user") return false
    void edit(first.id)
    return true
  }

  /** New order of the queued prompts (ids of `queued()`), from a drag or ↑/↓ on the handle. */
  function reorder(order: readonly string[]) {
    if (revertStaged()) {
      input.onProblem?.("revertBlocked")
      return Promise.resolve(false)
    }
    return run(async (runtime, sessionID) => {
      const authoritative = await runtime.client().session.inbox.list({ sessionID })
      const plan = reorderPlan(authoritative, order)
      if (plan.kind === "none") return
      if (plan.kind === "blocked") throw new QueueChanged(plan.reason === "control" ? "reorderBlocked" : "changed")
      // Admit before cancelling, so a failed re-admission never loses a prompt (upstream order). A re-admission can
      // fail (a referenced file may be gone): the copies already admitted are withdrawn, so the queue stays as it was
      // instead of holding duplicates (upstream 2db9c2e1b3). Each id is chosen before sending, since the server can
      // admit a prompt whose response then fails.
      const admitted: string[] = []
      for (const entry of plan.readmit) {
        const id = SessionMessage.ID.create()
        admitted.push(id)
        await runtime.data.session
          .prompt({
            id,
            sessionID,
            text: entry.payload.text,
            files: readmitFiles(entry.payload),
            agents: entry.payload.agents?.map((agent) => ({ name: agent.name, mention: agent.mention })),
            skills: entry.payload.skills?.map((skill) => ({ id: skill.id, mention: skill.mention })),
            metadata: entry.payload.metadata,
            delivery: "queue",
            resume: false,
          })
          .catch(async (error: unknown) => {
            await Promise.all(
              admitted.map((inboxID) =>
                runtime
                  .client()
                  .session.inbox.cancel({ sessionID, inboxID })
                  .catch(() => undefined),
              ),
            )
            throw error
          })
      }
      for (const inboxID of plan.cancel) await runtime.client().session.inbox.cancel({ sessionID, inboxID })
    })
  }

  const moveItem = (inboxID: string, delta: number) => reorder(moveBy(queued(), inboxID, delta))

  return {
    rows,
    /** Ids of the queued (not steered) prompts, the only rows that reorder. */
    queued,
    /** A change is running: rows are locked. */
    working,
    revertStaged,
    count: () => rows().length,
    toggle,
    sendNow,
    cancel,
    edit,
    editFirst,
    reorder,
    moveItem,
  }
}

class QueueChanged extends Error {
  constructor(readonly problem: QueueProblem) {
    super(problem)
  }
}
