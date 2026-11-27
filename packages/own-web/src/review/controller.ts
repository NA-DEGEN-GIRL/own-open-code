// Review tab data (03 §18.5): the session's folder, its VCS info and base (vcs.get / vcs.base, branch list on demand),
// the mode, and the changed files of that mode (vcs.diff working|branch, session.diff for the last turn or the whole
// session, Session.revert.files). Nothing is fetched while the tab is hidden; events only mark the data stale and the
// next visible frame refreshes once (R8/R9, no polling). Events: a turn end of this session (and the switch to
// `마지막 턴` unless the user chose a mode), file changes and branch updates of this folder, revert staging, reconnect.
import type { FileDiffInfo, OpenCodeClient, VcsBase } from "@opencode/client"
import { batch, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useData, type ServerKey } from "@/data"
import { debounce } from "./debounce"
import {
  activeFile,
  availableModes,
  branchModeAvailable,
  defaultMode,
  sortDiffs,
  summarize,
  TRIM_CONTEXT,
  type ReviewMode,
} from "./model"
import { reviewKey, reviewState } from "./state"

/** Event bursts (a turn writing many files) refresh once, at most every 400 ms (R3). */
const REFRESH_MS = 400

interface DiffRequest {
  readonly key: string
  readonly mode: Exclude<ReviewMode, "reverted">
  readonly directory: string
  readonly sessionID: string
  readonly base?: string
}

export function createReviewController(input: {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
  readonly visible: () => boolean
}) {
  const data = useData()
  const runtime = () => data.get(input.serverKey())
  const connected = () => runtime()?.connection.status() === "connected"
  const key = () => {
    const sessionID = input.sessionID()
    return sessionID ? reviewKey(input.serverKey(), sessionID) : undefined
  }
  const saved = () => {
    const current = key()
    return current ? reviewState.get(current) : undefined
  }
  const session = () => {
    const sessionID = input.sessionID()
    return sessionID ? runtime()?.data.session.get(sessionID) : undefined
  }
  const directory = () => {
    const sessionID = input.sessionID()
    if (!sessionID) return undefined
    return session()?.location.directory ?? runtime()?.sessions.directory(sessionID)
  }
  const running = () => {
    const sessionID = input.sessionID()
    return sessionID ? runtime()?.data.session.status(sessionID) === "running" : false
  }
  const reverted = () => session()?.revert?.files ?? []

  const [store, setStore] = createStore({
    vcs: undefined as
      | {
          readonly directory: string
          readonly git: boolean
          readonly current?: string
          readonly base?: VcsBase | null
          readonly root?: string
        }
      | undefined,
    branches: undefined as { readonly directory: string; readonly list: readonly string[] } | undefined,
    diffs: [] as FileDiffInfo[],
    diffsKey: undefined as string | undefined,
    loading: false,
    error: undefined as string | undefined,
    width: undefined as number | undefined,
    /** Session whose info fetch finished (the default mode waits for its idle time, or for the fetch to fail). */
    infoTried: undefined as string | undefined,
    /** Folder a `Git 저장소 만들기` runs for (18.5). */
    initializing: undefined as string | undefined,
  })
  const [version, setVersion] = createSignal(0)
  const [vcsVersion, setVcsVersion] = createSignal(0)
  const refreshDiffs = debounce(() => setVersion((value) => value + 1), REFRESH_MS)
  const refreshVcs = debounce(() => setVcsVersion((value) => value + 1), REFRESH_MS)
  onCleanup(() => {
    refreshDiffs.cancel()
    refreshVcs.cancel()
  })

  const vcs = () => {
    const current = store.vcs
    return current && current.directory === directory() ? current : undefined
  }
  // The project row knows the VCS at once; vcs.get of a folder the server has just opened reports no provider until
  // its provider registers (then `vcs.branch.updated` arrives and the info is fetched again).
  const git = () => {
    const projectID = session()?.projectID
    const project = projectID ? runtime()?.data.project.get(projectID) : undefined
    return Boolean(project?.vcs) || (vcs()?.git ?? false)
  }
  const infoReady = () => session() !== undefined || store.infoTried === input.sessionID()
  const modes = createMemo<ReviewMode[]>(() => {
    const info = vcs()
    if (!info || !infoReady()) return []
    return availableModes({
      vcs: git(),
      branch: branchModeAvailable(info.current, info.base),
      reverted: reverted().length > 0,
    })
  })
  const mode = createMemo<ReviewMode | undefined>(() => {
    const list = modes()
    if (list.length === 0) return undefined
    const stored = saved()?.mode
    if (stored && list.includes(stored)) return stored
    return defaultMode({ vcs: git(), running: running(), idleAt: session()?.time.idle, now: Date.now() })
  })
  // The default is decided once per session so it does not flip while the user reads (e.g. 5 minutes later). Without
  // Git the default is always `마지막 턴`, so it is not stored: a folder reported without VCS too early still gets
  // its time-based default once the provider shows up.
  createEffect(() => {
    const current = key()
    const value = mode()
    if (current && value && git() && untrack(() => reviewState.get(current).mode) === undefined)
      reviewState.setMode(current, value, false)
  })

  /** The base of `브랜치 대 base`: the user's pick, else the inferred one; undefined asks the user. */
  const base = () => saved()?.base ?? vcs()?.base?.ref
  const baseName = () => saved()?.base ?? vcs()?.base?.name

  const request = createMemo<DiffRequest | undefined>(() => {
    const value = mode()
    const sessionID = input.sessionID()
    const folder = directory()
    if (!value || value === "reverted" || !sessionID || !folder) return undefined
    const chosen = value === "branch" ? base() : undefined
    if (value === "branch" && !chosen) return undefined
    return {
      key: JSON.stringify([input.serverKey(), sessionID, folder, value, chosen ?? null]),
      mode: value,
      directory: folder,
      sessionID,
      base: chosen,
    }
  })

  // Session info (revert files, idle time) when the transcript has not loaded it.
  createEffect(() => {
    const sessionID = input.sessionID()
    const current = runtime()
    if (!input.visible() || !sessionID || !current || !connected() || session()) return
    void current.data.session
      .sync(sessionID)
      .catch(() => undefined)
      .then(() => setStore("infoTried", sessionID))
  })

  // VCS info and base of the folder: on first view, on branch updates, reconnects, refresh and entering branch mode.
  const vcsFetched = { key: "" }
  createEffect(() => {
    const folder = directory()
    const current = runtime()
    const stamp = vcsVersion()
    if (!input.visible() || !folder || !current || !connected()) return
    const id = JSON.stringify([folder, stamp])
    if (vcsFetched.key === id) return
    vcsFetched.key = id
    void loadVcs(current.client(), folder).then((info) => {
      if (vcsFetched.key === id) setStore("vcs", info)
    })
  })
  createEffect(
    on(mode, (value, previous) => {
      if (value === "branch" && previous !== undefined && previous !== "branch") setVcsVersion((stamp) => stamp + 1)
    }),
  )

  // Branch list for the base picker while branch mode is shown; again with the VCS info (refresh, branch updates).
  const branchesFetched = { key: "" }
  createEffect(() => {
    const folder = directory()
    const current = runtime()
    const stamp = vcsVersion()
    if (!input.visible() || mode() !== "branch" || !folder || !current || !connected()) return
    const id = JSON.stringify([folder, stamp])
    if (branchesFetched.key === id) return
    branchesFetched.key = id
    void current
      .client()
      .vcs.branch.list({ location: { directory: folder }, limit: 100 })
      .then((output) => {
        if (branchesFetched.key === id) setStore("branches", { directory: folder, list: output.data })
      })
      .catch(() => undefined)
  })

  // Changed files of the current request: when visible and the request or the refresh stamp changed.
  const fetched = { key: "", version: -1, token: 0 }
  createEffect(() => {
    const next = request()
    const stamp = version()
    const current = runtime()
    if (!input.visible() || !next || !current || !connected()) return
    if (fetched.key === next.key && fetched.version === stamp) return
    const changed = fetched.key !== next.key
    fetched.key = next.key
    fetched.version = stamp
    const token = ++fetched.token
    batch(() => {
      if (changed) setStore({ diffs: [], diffsKey: undefined })
      setStore({ loading: true, error: undefined })
    })
    fetchDiffs(current.client(), next)
      .then((list) => {
        if (token === fetched.token) setStore({ diffs: sortDiffs(list), diffsKey: next.key, loading: false })
      })
      .catch((error: unknown) => {
        if (token === fetched.token) setStore({ loading: false, error: message(error) })
      })
  })

  // Events. Hidden tabs only bump the stamps; the effects above wait for the tab to be visible.
  createEffect(() => {
    const current = runtime()
    if (!current) return
    const ofThisFolder = (location: { readonly directory?: string } | undefined) =>
      !location?.directory || location.directory === untrack(directory)
    const ofThisSession = (sessionID: string) => sessionID === untrack(input.sessionID)
    const turnEnded = (sessionID: string) => {
      if (!ofThisSession(sessionID)) return
      refreshDiffs.schedule()
      const currentKey = untrack(key)
      if (currentKey && !reviewState.get(currentKey).manual) reviewState.setMode(currentKey, "lastTurn", false)
    }
    const offs = [
      current.bus.on("session.execution.succeeded", (event) => turnEnded(event.data.sessionID)),
      current.bus.on("session.execution.failed", (event) => turnEnded(event.data.sessionID)),
      current.bus.on("session.execution.interrupted", (event) => turnEnded(event.data.sessionID)),
      current.bus.on("filesystem.changed", (event) => {
        if (ofThisFolder(event.location)) refreshDiffs.schedule()
      }),
      current.bus.on("vcs.branch.updated", (event) => {
        if (!ofThisFolder(event.location)) return
        refreshVcs.schedule()
        refreshDiffs.schedule()
      }),
      current.bus.on("session.revert.staged", (event) => {
        if (ofThisSession(event.data.sessionID)) refreshDiffs.schedule()
      }),
      current.bus.on("session.revert.cleared", (event) => {
        if (ofThisSession(event.data.sessionID)) refreshDiffs.schedule()
      }),
      current.bus.on("session.revert.committed", (event) => {
        if (ofThisSession(event.data.sessionID)) refreshDiffs.schedule()
      }),
      current.bus.on("server.connected", () => {
        refreshVcs.schedule()
        refreshDiffs.schedule()
      }),
    ]
    onCleanup(() => offs.forEach((off) => off()))
  })

  // Seeing the review tab of a session clears its "changed in the last turn" badge.
  createEffect(() => {
    const current = key()
    if (input.visible() && current) reviewState.markLastTurnSeen(current)
  })

  const diffs = createMemo<FileDiffInfo[]>(() => {
    if (mode() === "reverted") return sortDiffs(reverted())
    const next = request()
    return next && store.diffsKey === next.key ? store.diffs : []
  })
  const files = createMemo(() => diffs().map((diff) => diff.file))
  const bounded = new Map<string, Promise<readonly FileDiffInfo[]>>()

  return {
    key,
    directory,
    running,
    modes,
    mode,
    git,
    vcsReady: () => vcs() !== undefined,
    branchName: () => vcs()?.current,
    /** Absolute repository root of the folder (Git only), when known. */
    root: () => (git() ? vcs()?.root : undefined),
    base: baseName,
    /** Branch mode without a base the server could infer (18.5 "모호하면 base를 고르세요"). */
    needsBase: () => mode() === "branch" && !base(),
    branches: () => {
      const branches = store.branches
      return branches && branches.directory === directory() ? branches.list : undefined
    },
    diffs,
    files,
    summary: createMemo(() => summarize(diffs())),
    active: () => activeFile(files(), saved()?.file),
    loading: () => store.loading,
    loaded: () => mode() === "reverted" || (request() !== undefined && store.diffsKey === request()?.key),
    error: () => store.error,
    listOpen: () => saved()?.listOpen ?? true,
    width: () => store.width,
    setWidth: (width: number) => setStore("width", width),
    selectMode(value: ReviewMode) {
      const current = key()
      if (current) reviewState.setMode(current, value, true)
    },
    selectBase(value: string) {
      const current = key()
      if (current) reviewState.setBase(current, value)
    },
    selectFile(file: string) {
      const current = key()
      if (current) reviewState.setFile(current, file)
    },
    setListOpen(open: boolean) {
      const current = key()
      if (current) reviewState.setListOpen(current, open)
    },
    refresh() {
      setVcsVersion((stamp) => stamp + 1)
      setVersion((stamp) => stamp + 1)
    },
    /**
     * `Git 저장소 만들기` (18.5, upstream 41516c78c8): a folder whose project has no repository, on a connection that
     * may write this PC's disk. The gateway refuses `/api/vcs/init` for paired devices, so they never see it.
     */
    canInitGit: () => vcs() !== undefined && !git() && (runtime()?.rpc.can("local") ?? false),
    initializingGit: () => store.initializing !== undefined && store.initializing === directory(),
    /**
     * `POST /api/vcs/init {provider:"git"}` in the folder's project directory; then the project (its `vcs`), the
     * session and the folder's VCS info are read again, so the Git modes appear. Resolves to the failure's message.
     */
    async initGit(): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
      const current = runtime()
      const folder = directory()
      const sessionID = input.sessionID()
      if (!current || !folder || store.initializing) return { ok: false, reason: "busy" }
      setStore("initializing", folder)
      const location = { directory: folder }
      return current
        .client()
        .vcs.init({ location, provider: "git" })
        .then(async () => {
          current.data.project.invalidate()
          current.data.location.invalidate(location)
          if (sessionID) current.data.session.invalidate(sessionID)
          await Promise.all([
            current.data.project.sync(),
            sessionID ? current.data.session.sync(sessionID) : undefined,
            current.data.location.syncInfo(location),
          ])
          setVcsVersion((stamp) => stamp + 1)
          setVersion((stamp) => stamp + 1)
          return { ok: true as const }
        })
        .catch((error: unknown) => ({ ok: false as const, reason: message(error) }))
        .finally(() => setStore("initializing", undefined))
    },
    /**
     * A file whose patch the server left out (over its byte budget): the same request again with 3 context lines,
     * which is much smaller, once per list version.
     */
    loadBounded(file: string): Promise<FileDiffInfo | undefined> {
      const next = request()
      const current = runtime()
      if (!next || !current) return Promise.resolve(undefined)
      const id = `${next.key}\0${version()}`
      const pending = bounded.get(id) ?? fetchDiffs(current.client(), next, TRIM_CONTEXT)
      if (!bounded.has(id)) bounded.clear()
      bounded.set(id, pending)
      return pending.then((list) => list.find((diff) => diff.file === file)).catch(() => undefined)
    },
  }
}

export type ReviewController = ReturnType<typeof createReviewController>

async function loadVcs(client: OpenCodeClient, directory: string) {
  const location = { directory }
  const [info, base, root] = await Promise.all([
    client.vcs.get({ location }).then(
      (output) => output.data,
      () => undefined,
    ),
    // 503 "Choose a review base" (ambiguous history) and null (no commits yet) both leave the choice to the user.
    client.vcs.base({ location }).then(
      (output) => output.data,
      () => null,
    ),
    // The repository root (the location's project directory): review paths are relative to it (19.1 comments).
    client.location.get({ location }).then(
      (output) => output.project.directory,
      () => undefined,
    ),
  ])
  return { directory, git: Boolean(info?.provider), current: info?.branch.current, base, root }
}

async function fetchDiffs(client: OpenCodeClient, request: DiffRequest, context?: number) {
  const location = { directory: request.directory }
  if (request.mode === "working") return (await client.vcs.diff({ location, mode: "working", context })).data
  if (request.mode === "branch")
    return (await client.vcs.diff({ location, mode: "branch", base: request.base, context })).data
  if (request.mode === "lastTurn") return client.session.diff({ sessionID: request.sessionID, context })
  // 이 세션 전체: the first user message's turn through the newest one's.
  const [first, last] = await Promise.all([
    client.message.list({ sessionID: request.sessionID, limit: 1, order: "asc", type: "user" }),
    client.message.list({ sessionID: request.sessionID, limit: 1, order: "desc", type: "user" }),
  ])
  const from = first.data[0]?.id
  const to = last.data[0]?.id
  if (!from || !to) return []
  return client.session.diff({ sessionID: request.sessionID, from, to, context })
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
