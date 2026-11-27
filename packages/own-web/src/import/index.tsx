// 다른 도구의 대화 (09 §6), first-chunk part. Small: the requests other screens make (`openImport` from the project
// menu, the palette and later screens; `requestMigrate` from the list and the viewer), `ImportLayer` (mounted once by
// the shell: it takes the open requests with the router and shows the I2 `이어서 하기` dialog, a lazy chunk),
// `ImportPage`, which loads the list or the read-only viewer as lazy chunks (03 §20.2 R5), and `ImportHint`, entry 4
// on a folder's empty new conversation. The per-server state the sidebar row, the project menu, the palette and the
// hint read (health, `새 N개`, `사이드바에 보이기`) is ./store.ts; every word of the screens is ./strings.ts, loaded
// with them (the hint's few words are first-chunk keys of src/i18n).
import { createEffect, createSignal, lazy, onCleanup, Show, Suspense, untrack } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { useI18n } from "@/i18n"
import { useRouter } from "@/routing/router"
import type { ImportRef } from "@/routing/routes"
import { importStore, refKey } from "./store"

export {
  importEntryCount,
  importGates,
  importSidebarShown,
  importStore,
  refKey,
  setImportSidebarShown,
  type ImportHealth,
  type ImportStore,
} from "./store"

const ImportList = lazy(() => import("./list"))
const ImportViewer = lazy(() => import("./viewer"))
const MigrateDialog = lazy(() => import("./dialog"))

/** The list of a project's conversations in other tools, or one of them read only (at `turn`, 0-based). */
export interface ImportTarget {
  readonly serverKey: ServerKey
  readonly projectID: string
  readonly ref?: ImportRef
  readonly turn?: number
}

/** `이어서 하기` of a conversation (I2, 09 §4, §6): the dialog that plans and runs the move. */
export interface MigrateTarget {
  readonly serverKey: ServerKey
  readonly projectID: string
  /** The folder the list was opened for (`migrate.plan.directory`). */
  readonly directory: string
  readonly ref: ImportRef
  /** `이 폴더로 가져오기` in `모든 폴더`: import into the list's folder instead of the conversation's own. */
  readonly location?: string
  /** `여기까지 이어서 하기` on a user turn of the viewer: the last turn to import (0-based). */
  readonly upToTurn?: number
  /** The model the tool used last (`원래: <모델>`). */
  readonly original?: string
  /** The conversation's turns when the caller knows them (the `여기까지` field's range). */
  readonly turns?: number
}

/** One kind of request: the screen that answers registers once; a request made before that waits (only the latest). */
function channel<T>() {
  const slot: { handler?: (request: T) => void; held?: T } = {}
  return {
    send(request: T) {
      if (slot.handler) return slot.handler(request)
      slot.held = request
    },
    register(handler: (request: T) => void) {
      slot.handler = handler
      const held = slot.held
      slot.held = undefined
      if (held) handler(held)
      return () => {
        if (slot.handler === handler) slot.handler = undefined
      }
    },
  }
}

export const importIntents = {
  open: channel<ImportTarget>(),
  migrate: channel<MigrateTarget>(),
}

/** Opens the list (09 §6 entries 1–3) or a conversation in the read-only viewer. */
export function openImport(target: ImportTarget) {
  importIntents.open.send(target)
}

/** `이어서 하기` (I2): `ImportLayer` takes it and opens the dialog (a newer request replaces an open one). */
export function requestMigrate(target: MigrateTarget) {
  importIntents.migrate.send(target)
}

/** A turn the next viewer of a conversation scrolls to (a content search hit); taken once. */
const jumps = new Map<string, number>()

export const viewerJump = {
  set(ref: ImportRef, turn: number) {
    jumps.set(refKey(ref), turn)
  },
  take(ref: ImportRef) {
    const key = refKey(ref)
    const turn = jumps.get(key)
    jumps.delete(key)
    return turn
  },
}

export function ImportLayer() {
  const router = useRouter()
  const [migrate, setMigrate] = createSignal<MigrateTarget>()
  onCleanup(
    importIntents.open.register((target) => {
      if (target.ref && target.turn !== undefined) viewerJump.set(target.ref, target.turn)
      router.navigate({
        name: "import",
        serverKey: target.serverKey,
        projectID: target.projectID,
        ...(target.ref ? { ref: target.ref } : {}),
      })
    }),
  )
  onCleanup(importIntents.migrate.register((target) => setMigrate(target)))
  return (
    <Show when={migrate()} keyed>
      {(target) => (
        <Suspense>
          <MigrateDialog target={target} onClose={() => setMigrate(undefined)} />
        </Suspense>
      )}
    </Show>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Entry 4 (09 §6 들어가는 곳 4): `이 폴더에 아직 가져오지 않은 … 대화 N개가 있습니다 · 보기` on a folder's empty new
// conversation, once per folder and viewer: remembered when first shown, it stays on that view until `보기` or ✕.
// The count is the sidebar's (`sessions.list{limit: 0}.fresh`, asked after the list paint, 03 §20.2 R8).

const HINT_KEY = "own.web.import.hint"
const HINT_LIMIT = 200
const [hinted, setHinted] = createSignal<ReadonlySet<string>>(readHinted())

export function ImportHint(props: {
  readonly serverKey: ServerKey
  readonly projectID: string
  readonly directory: string | undefined
}) {
  const data = useData()
  const i18n = useI18n()
  const key = `${props.serverKey}|${props.projectID}`
  const [here, setHere] = createSignal(!hinted().has(key))
  const runtime = () => data.get(props.serverKey)
  createEffect(() => {
    const current = runtime()
    const directory = props.directory
    if (current && directory && here()) untrack(() => importStore(current).watch(props.projectID, directory))
  })
  const count = () => {
    const current = runtime()
    return current && here() ? importStore(current).fresh(props.projectID) : 0
  }
  createEffect(() => {
    if (count() > 0) untrack(() => rememberHint(key))
  })
  return (
    <Show when={count() > 0}>
      <div
        class="mx-auto flex w-full max-w-[var(--own-content-max)] flex-wrap items-center gap-2 rounded-lg border border-own-border bg-own-subtle px-3 py-2 text-[12.5px]"
        role="status"
        data-testid="import-hint"
      >
        <span class="min-w-0 flex-1">{i18n.t("own.otherTools.hint", { n: count() })}</span>
        <button
          type="button"
          class="rounded-md border border-own-border px-2 py-0.5 hover:bg-own-hover"
          data-testid="import-hint-open"
          onClick={() => {
            setHere(false)
            openImport({ serverKey: props.serverKey, projectID: props.projectID })
          }}
        >
          {i18n.t("own.otherTools.hintOpen")}
        </button>
        <button
          type="button"
          class="rounded-md px-1.5 py-0.5 text-own-muted hover:bg-own-hover"
          aria-label={i18n.t("own.otherTools.hintClose")}
          data-testid="import-hint-close"
          onClick={() => setHere(false)}
        >
          ×
        </button>
      </div>
    </Show>
  )
}

function readHinted(): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(HINT_KEY) ?? "[]")
    return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string") : [])
  } catch {
    return new Set()
  }
}

function rememberHint(key: string) {
  if (hinted().has(key)) return
  const next = [...hinted(), key].slice(-HINT_LIMIT)
  setHinted(new Set(next))
  try {
    localStorage.setItem(HINT_KEY, JSON.stringify(next))
  } catch {}
}

/** The page of the `import` route (a page over the session view, like settings). */
export function ImportPage(props: {
  readonly serverKey: ServerKey
  readonly projectID: string
  /** The route's conversation; absent: the list. (`ref` is Solid's element-ref prop, hence the name.) */
  readonly sourceRef?: ImportRef
}) {
  const i18n = useI18n()
  return (
    <Suspense fallback={<p class="own-placeholder">{i18n.t("own.shell.loading")}</p>}>
      <Show
        when={props.sourceRef}
        keyed
        fallback={<ImportList serverKey={props.serverKey} projectID={props.projectID} />}
      >
        {(ref) => <ImportViewer serverKey={props.serverKey} projectID={props.projectID} sourceRef={ref} />}
      </Show>
    </Suspense>
  )
}
