// Request model of one open session (03 §18.1–18.2; reference: packages/app/src/session/requests/model.ts, whose
// runtime wiring — useParams, useServerSDK, the auto-approve setting — does not exist here). The open session and
// every known descendant form a tree (vendored `sessionTreeIDs`), so a subagent's permission request or question also
// shows in the parent's dock: otherwise the turn stops out of sight ([gap] 1). MCP elicitations are Location-scoped
// forms on the "global" owner (packages/core/src/mcp/index.ts:80-82) and show in every session of that directory.
//
// First chunk: memos over the createData stores only; the dock views load lazily when the first item appears.
import type { FormAnswer, PermissionReply, PermissionRequest } from "@opencode/client"
import type { FormWithLocation } from "@opencode/client/solid"
import { createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import type { ServerRuntime } from "@/data"
import { showToast } from "@/switcher/toast"
import { agentPath, formFlavor, type Flavor } from "./describe"
import { sessionTreeIDs } from "./vendor/session-request-tree"

/** Owner id of MCP elicitation forms (packages/client/src/solid/data.ts:119). */
export const GLOBAL_FORMS = "global"
/** A shutdown this soon after requests were ended by someone else explains them (03 §8 "권한·질문 취소"). */
const SHUTDOWN_WINDOW_MS = 5_000

export interface Origin {
  /** The session that asked. */
  readonly sessionID: string
  /** Agents from the open session down to the asking subagent session; empty for the open session itself. */
  readonly agents: readonly string[]
}

export type RequestItem =
  | { readonly kind: "permission"; readonly key: string; readonly request: PermissionRequest; readonly origin: Origin }
  | {
      readonly kind: "form"
      readonly key: string
      readonly form: FormWithLocation
      readonly flavor: Flavor
      readonly origin: Origin
    }

export interface RequestModelInput {
  readonly runtime: () => ServerRuntime | undefined
  readonly sessionID: () => string | undefined
  /** Localized toast text for failures (the model has no i18n of its own). */
  readonly text: { readonly failed: () => string; readonly cancelledByReload: () => string }
}

export function createRequestModel(input: RequestModelInput) {
  const data = () => input.runtime()?.data
  const connected = () => input.runtime()?.connection.status() === "connected"
  const directory = () => {
    const runtime = input.runtime()
    const id = input.sessionID()
    if (!runtime || !id) return undefined
    return runtime.data.session.get(id)?.location.directory ?? runtime.sessions.directory(id)
  }

  // Family members are registered as their infos arrive (session.created → sync); only parentIDs are read here, so
  // streaming (usage, titles) does not recompute the tree (R1/R3).
  const tree = createMemo(
    () => {
      const current = data()
      const id = input.sessionID()
      if (!current || !id) return []
      const sessions = current.session.family(id).flatMap((member) => {
        const info = current.session.get(member)
        return info ? [info] : []
      })
      return sessionTreeIDs(sessions, id)
    },
    [],
    { equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]) },
  )

  // Children of the open session appear through `session.list?parentID` (deduped with the sidebar's call).
  createEffect(
    on([input.sessionID, connected], ([id, online]) => {
      const current = data()
      // A session this window is still creating has nothing on the server yet; its echo and events fill it in.
      if (!current || !id || !online || current.session.creating(id)) return
      void current.session.sync(id, { children: true }).catch(report)
    }),
  )
  // Pending permissions and forms of every tree member, and the directory's elicitations. `sync.run` dedupes by key
  // until a reconnect invalidates it; events (`permission.asked`, `form.created`, …) keep them current afterwards.
  createEffect(() => {
    const current = data()
    const ids = tree()
    const location = directory()
    if (!current || !connected()) return
    untrack(() => {
      for (const id of ids) {
        if (current.session.creating(id)) continue
        void current.session.permission.sync(id).catch(report)
        void current.session.form.sync(id).catch(report)
      }
      if (location !== undefined) void current.session.form.sync(GLOBAL_FORMS, { directory: location }).catch(report)
    })
  })

  const items = createMemo<RequestItem[]>(() => {
    const current = data()
    const id = input.sessionID()
    if (!current || !id) return []
    const origin = (sessionID: string): Origin => ({
      sessionID,
      agents: agentPath(id, sessionID, (member) => current.session.get(member)),
    })
    const ids = tree()
    const permissions = ids.flatMap((member) =>
      (current.session.permission.list(member) ?? []).map(
        (request): RequestItem => ({ kind: "permission", key: `p:${request.id}`, request, origin: origin(member) }),
      ),
    )
    const forms = ids.flatMap((member) =>
      (current.session.form.list(member) ?? []).map(
        (form): RequestItem => ({
          kind: "form",
          key: `f:${form.id}`,
          form,
          flavor: formFlavor(form),
          origin: origin(member),
        }),
      ),
    )
    const location = directory()
    const global =
      location === undefined
        ? []
        : (current.session.form.list(GLOBAL_FORMS, { directory: location }) ?? []).map(
            (form): RequestItem => ({
              kind: "form",
              key: `f:${form.id}`,
              form,
              flavor: formFlavor(form),
              origin: { sessionID: id, agents: [] },
            }),
          )
    // 03 §4.6: what stops the turn first — permissions, then questions and forms.
    return [...permissions, ...forms, ...global]
  })

  const [front, setFront] = createSignal<string>()
  const current = createMemo(() => {
    const list = items()
    return list.find((item) => item.key === front()) ?? list[0]
  })
  const others = createMemo(() => items().filter((item) => item !== current()))

  const [busy, setBusy] = createStore<Record<string, boolean | undefined>>({})

  // 03 §8 "권한·질문 취소": another client's `location.reload` rejects every pending request of that Location. Core
  // publishes those rejections (and form cancellations) before `location.shutdown` (packages/core/src/location-
  // lifecycle.ts:43-55), so the dock is already empty when the shutdown arrives: remember what was pending at the
  // last flush (effects run after the event batch) and when requests were ended by someone else.
  const shown = { keys: new Set<string>(), foreign: 0 }
  createEffect(() => {
    shown.keys = new Set(items().map((item) => item.key))
  })
  createEffect(() => {
    const runtime = input.runtime()
    if (!runtime) return
    const ended = (key: string) => {
      if (shown.keys.has(key) && !busy[key]) shown.foreign = Date.now()
    }
    onCleanup(
      runtime.bus.on("permission.replied", (event) => {
        if (event.data.reply === "reject") ended(`p:${event.data.requestID}`)
      }),
    )
    onCleanup(runtime.bus.on("form.cancelled", (event) => ended(`f:${event.data.id}`)))
    onCleanup(
      runtime.bus.on("location.shutdown", (event) => {
        if (event.location?.directory === undefined || event.location.directory !== directory()) return
        if (!shown.keys.size && Date.now() - shown.foreign > SHUTDOWN_WINDOW_MS) return
        showToast({ message: input.text.cancelledByReload() })
        for (const id of untrack(tree)) {
          runtime.data.session.permission.invalidate(id)
          runtime.data.session.form.invalidate(id)
        }
      }),
    )
  })

  async function run(key: string, work: () => Promise<unknown>) {
    if (busy[key]) return false
    setBusy(key, true)
    try {
      await work()
      return true
    } catch (error) {
      report(error)
      showToast({ message: input.text.failed(), tone: "danger" })
      return false
    } finally {
      setBusy(key, undefined)
    }
  }

  return {
    items,
    current,
    others,
    tree,
    directory,
    connected,
    busy: (key: string) => busy[key] === true,
    /** Brings a folded request to the front (03 §18.1 `다른 요청 2개`). */
    show: (key: string) => setFront(key),
    /** Other pending permissions of the same session: a rejection rejects them too (permission.ts:276-292). */
    siblings: (request: PermissionRequest) =>
      items().filter((item) => item.kind === "permission" && item.request.sessionID === request.sessionID).length - 1,
    decide(request: PermissionRequest, decision: PermissionReply, message?: string) {
      const current = data()
      if (!current) return Promise.resolve(false)
      return run(`p:${request.id}`, () =>
        current.session.permission.reply({
          sessionID: request.sessionID,
          requestID: request.id,
          decision,
          ...(message ? { message } : {}),
        }),
      )
    },
    reply(form: FormWithLocation, answer: FormAnswer) {
      const current = data()
      if (!current) return Promise.resolve(false)
      return run(`f:${form.id}`, () =>
        current.session.form.reply({ sessionID: form.sessionID, formID: form.id, answer }, form.location),
      )
    },
    cancel(form: FormWithLocation) {
      const current = data()
      if (!current) return Promise.resolve(false)
      return run(`f:${form.id}`, () =>
        current.session.form.cancel({ sessionID: form.sessionID, formID: form.id }, form.location),
      )
    },
  }
}

export type RequestModel = ReturnType<typeof createRequestModel>

function report(error: unknown) {
  console.error("[own-web] request dock", error)
}
