// 다른 도구의 대화: the list (09 §6 목록), a lazy page over the session view (03 §20.2 R5). One project's conversations
// in Codex and Claude Code, newest first, 50 per page (`sessions.list`; `더 보기` and the near-end scroll read on with
// the cursor). Filters: `전체 / Codex / Claude Code` (the loaded rows, the method has no kind input), `이 폴더 / 모든
// 폴더` (grouped by cwd), and `하위 에이전트`, `보관됨`, `자동 실행` (off by default). The search box finds titles
// (`sessions.list{query}`); with `내용까지` it also finds what the user and the model wrote (`sessions.search` over the
// folder, partial results continued with the cursor: `일부만 찾음 · 계속 찾기`). Rows are virtual (R2) with fixed
// heights (R7); sub-agent conversations fold under their parent. `index.changed` re-reads the first page. The search
// input follows 03 §12 (uncontrolled, results update outside the input, Enter after a commit only commits).
import { abort } from "@opencode/util/abort"
import "./import.css"
import { createVirtualizer } from "@tanstack/solid-virtual"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js"
import { createStore } from "solid-js/store"
import { importEvent, useData, type ServerKey, type ServerRuntime } from "@/data"
import { nextFrame } from "@/data/frame"
import { useI18n } from "@/i18n"
import { clearNextFrame, createImeEnter } from "@/ime/ime-enter"
import { Segmented, Tag } from "@/limits/kit"
import { inputSampler } from "@/perf/event-timing"
import { baseName, samePath } from "@/projects/path"
import { RouteLink } from "@/routing/router"
import { minuteNow } from "@/shell/clock"
import { relativeTime } from "@/shell/format"
import { Icon } from "@/shell/icons"
import { projectRef, syncProjects } from "@/worktree/api"
import { openImport, requestMigrate } from "./index"
import {
  CLAUDE_CLEANUP_DAYS,
  DEFAULT_FILTERS,
  errorText,
  expiry,
  hitGroups,
  lastModel,
  listInput,
  listRows,
  mergeHits,
  refKey,
  routeRef,
  rowTags,
  TOOL_NAME,
  type Hit,
  type KindFilter,
  type ListFilters,
  type ListRow,
  type RowTag,
  type Summary,
} from "./model"
import { importGates, importStore } from "./store"
import { useImportText, type ImportKey } from "./strings"

/** Title search waits this long after the last keystroke before asking (the results update outside the input). */
const QUERY_DELAY = 250
/** `sessions.search` hits per call (09 §3: at most 100). */
const HIT_LIMIT = 100
/** Snippets shown per conversation in the content results. */
const HITS_SHOWN = 3
const HEIGHT = { folder: 36, item: 92, heading: 36, group: 36, hit: 26, status: 44 } as const

type DisplayRow =
  | ListRow
  | { readonly type: "heading"; readonly key: string }
  | {
      readonly type: "hits"
      readonly key: string
      readonly ref: Hit["ref"]
      readonly hits: readonly Hit[]
    }
  | {
      readonly type: "status"
      readonly key: string
      readonly kind: "searching" | "partial" | "none" | "more" | "loading"
    }

/** What a project's list keeps while the viewer is open (back to the list keeps the filters and the search). */
const memory = new Map<string, { filters: ListFilters; query: string; content: boolean; open: readonly string[] }>()

export default function ImportList(props: { readonly serverKey: ServerKey; readonly projectID: string }) {
  const data = useData()
  const text = useImportText()
  return (
    <section class="own-import" data-testid="page-import">
      <Show
        when={data.get(props.serverKey)}
        keyed
        fallback={<p class="own-placeholder">{text("own.otherTools.projectMissing")}</p>}
      >
        {(runtime) => <ProjectList runtime={runtime} serverKey={props.serverKey} projectID={props.projectID} />}
      </Show>
    </section>
  )
}

function ProjectList(props: {
  readonly runtime: ServerRuntime
  readonly serverKey: ServerKey
  readonly projectID: string
}) {
  const i18n = useI18n()
  const text = useImportText()
  const runtime = props.runtime
  const store = importStore(runtime)
  syncProjects(runtime)
  void store.ensure()
  const gates = () => importGates(store.health(), runtime.imports.allowed)
  const directory = () => projectRef(runtime, props.projectID)?.root
  const memoryKey = `${props.serverKey}/${props.projectID}`
  const saved = memory.get(memoryKey)

  const [chosen, setFilters] = createSignal<ListFilters>(saved?.filters ?? DEFAULT_FILTERS)
  // `모든 폴더` reaches every conversation on the PC, outside own's project folders: this PC's windows only (09 §5.5).
  const filters = createMemo(() =>
    gates().allFolders || chosen().scope === "folder" ? chosen() : { ...chosen(), scope: "folder" as const },
  )
  const [query, setQuery] = createSignal(saved?.query ?? "")
  const [content, setContent] = createSignal(saved?.content ?? false)
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set(saved?.open ?? []))
  onCleanup(() => memory.set(memoryKey, { filters: filters(), query: query(), content: content(), open: [...open()] }))

  const [list, setList] = createStore<{
    items: Summary[]
    total: number
    cursor: string | null
    scanning: boolean
    loading: boolean
    loaded: boolean
    error?: string
  }>({ items: [], total: 0, cursor: null, scanning: false, loading: false, loaded: false })

  // One list request at a time; a newer first-page request drops an older answer.
  let generation = 0
  let controller: AbortController | undefined
  onCleanup(() => abort(controller))

  async function load(more: boolean) {
    const folder = directory()
    if (!folder || !gates().list) return
    if (more && (!list.cursor || list.loading)) return
    if (!more) controller?.abort()
    const current = more ? (controller ?? new AbortController()) : new AbortController()
    controller = current
    const id = more ? generation : ++generation
    setList("loading", true)
    const output = await runtime.imports
      .call("sessions.list", listInput(folder, filters(), query(), more ? (list.cursor ?? undefined) : undefined), {
        signal: current.signal,
      })
      .catch((error: unknown) => (current.signal.aborted ? undefined : failure(error)))
    if (id !== generation || current.signal.aborted || !output) return
    if ("error" in output) return setList({ loading: false, loaded: true, error: output.error })
    setList({
      items: more ? [...list.items, ...output.items] : [...output.items],
      total: output.total,
      cursor: output.cursor,
      scanning: output.scanning,
      loading: false,
      loaded: true,
      error: undefined,
    })
    // The folder's unimported count, read anyway: the sidebar's `새 N개` follows it.
    if (filters().scope === "folder" && !query().trim()) store.setFresh(props.projectID, output.fresh)
  }

  function failure(error: unknown) {
    return { error: errorText(text, error) }
  }

  // Ask again when what the server filters changes (not the kind: that is the loaded rows) and once own.import and
  // the project are known.
  const asked = createMemo(() => {
    const current = filters()
    const input = [current.scope, current.subagents, current.archived, current.exec, query()]
    return JSON.stringify([gates().list, directory(), ...input])
  })
  createEffect(on(asked, () => void load(false)))

  // `index.changed` (09 §5.3): a scan ended or found more; the first page is read again, the rows stay until then.
  let refresh: ReturnType<typeof setTimeout> | undefined
  const stop = runtime.bus.listen((raw) => {
    const event = importEvent(raw)
    if (event?.name !== "index.changed") return
    const folder = directory()
    const named = event.data.directories
    if (!folder || (named && !named.some((item) => samePath(item, folder)) && !list.scanning)) return
    clearTimeout(refresh)
    refresh = setTimeout(() => void load(false), 300)
  })
  onCleanup(() => {
    stop()
    clearTimeout(refresh)
  })

  // 내용까지 (09 §3): the folder's user and model text, partial results continued with the cursor.
  const [search, setSearch] = createStore<{
    hits: Hit[]
    complete: boolean
    cursor?: string
    running: boolean
    error?: string
  }>({ hits: [], complete: true, running: false })
  let searchController: AbortController | undefined
  onCleanup(() => abort(searchController))
  const searching = () => content() && query().trim().length > 0 && gates().search

  async function findContent(more: boolean) {
    const folder = directory()
    const words = query().trim().slice(0, 200)
    if (!folder || !words || !gates().search) return
    searchController?.abort()
    const current = new AbortController()
    searchController = current
    setSearch({ running: true, error: undefined, ...(more ? {} : { hits: [], complete: true, cursor: undefined }) })
    const output = await runtime.imports
      .call(
        "sessions.search",
        {
          directory: folder,
          query: words,
          limit: HIT_LIMIT,
          ...(more && search.cursor ? { cursor: search.cursor } : {}),
        },
        { signal: current.signal },
      )
      .catch((error: unknown) => (current.signal.aborted ? undefined : failure(error)))
    if (current.signal.aborted || !output) return
    if ("error" in output) return setSearch({ running: false, error: output.error })
    setSearch({
      hits: more ? mergeHits(search.hits, output.hits) : [...output.hits],
      complete: output.complete,
      cursor: output.cursor,
      running: false,
    })
  }
  createEffect(
    on(
      () => [searching(), query()] as const,
      ([active]) => {
        if (active) return void findContent(false)
        searchController?.abort()
        setSearch({ hits: [], complete: true, cursor: undefined, running: false, error: undefined })
      },
    ),
  )

  const rows = createMemo<DisplayRow[]>(() => {
    const base = listRows(list.items, filters(), open())
    const more: DisplayRow[] = list.cursor
      ? [{ type: "status", key: "more", kind: list.loading ? "loading" : "more" }]
      : []
    if (!searching()) return [...base, ...more]
    const groups = hitGroups(search.hits).map(
      (group): DisplayRow => ({ type: "hits", key: `hits:${refKey(group.ref)}`, ref: group.ref, hits: group.hits }),
    )
    const state: DisplayRow[] = search.running
      ? [{ type: "status", key: "search", kind: "searching" }]
      : !search.complete && search.cursor
        ? [{ type: "status", key: "search", kind: "partial" }]
        : groups.length === 0
          ? [{ type: "status", key: "search", kind: "none" }]
          : []
    return [...base, ...more, { type: "heading", key: "heading" }, ...groups, ...state]
  })
  const known = createMemo(() => new Map(list.items.map((item) => [refKey(item.ref), item])))

  // Set once the element is in the document (it renders after own.import answered): a detached one is never measured.
  const [scroller, setScroller] = createSignal<HTMLDivElement>()
  const virtualizer = createVirtualizer({
    get count() {
      return rows().length
    },
    getScrollElement: () => scroller() ?? null,
    estimateSize: (index) => rowHeight(rows()[index]),
    overscan: 6,
    get getItemKey() {
      const current = rows()
      return (index: number) => current[index]?.key ?? index
    },
  })
  // Near the end of the loaded rows: the next page (09 §5.2: 50 per page).
  createEffect(() => {
    const last = virtualizer.getVirtualItems().at(-1)
    if (last && list.cursor && !list.loading && last.index >= rows().length - 3) untrack(() => void load(true))
  })

  const toggleChildren = (key: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  const setFilter = <K extends keyof ListFilters>(key: K, value: ListFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }))

  const empty = () => list.loaded && !list.loading && rows().length === 0 && !list.error

  return (
    <Show
      when={store.health() !== undefined}
      fallback={<p class="own-placeholder">{text("own.otherTools.checking")}</p>}
    >
      <Show
        when={gates().list}
        fallback={
          <p class="own-placeholder" data-testid="import-unavailable">
            {store.health() ? text("own.otherTools.deviceOnly") : text("own.otherTools.unavailable")}
          </p>
        }
      >
        <Show when={directory()} fallback={<p class="own-placeholder">{text("own.otherTools.projectMissing")}</p>}>
          {(folder) => (
            <>
              <header class="own-import-head">
                <div class="own-import-title">
                  <h2 class="m-0 text-[18px] font-semibold leading-7">{i18n.t("own.otherTools.title")}</h2>
                  <Show when={list.loaded}>
                    <span class="own-num text-[12.5px] text-own-muted" data-testid="import-total">
                      {text("own.otherTools.list.total", { n: list.total })}
                    </span>
                  </Show>
                  {/* Settings > 다른 도구 is this PC's windows' only (09 §5.5): a device would land on a dead end. */}
                  <Show when={gates().configure}>
                    <RouteLink
                      to={{ name: "settings", section: "import" }}
                      class="ml-auto text-[12.5px] text-own-muted underline-offset-2 hover:underline"
                      data-testid="import-list-settings"
                    >
                      {text("own.otherTools.list.settings")}
                    </RouteLink>
                  </Show>
                </div>
                <p class="m-0 text-[12.5px] text-own-muted" title={folder()}>
                  {text("own.otherTools.list.lead", { folder: baseName(folder()) })}
                </p>
                <div class="own-import-filters">
                  <Segmented<KindFilter>
                    label={text("own.otherTools.filter.kind")}
                    value={filters().kind}
                    options={[
                      { value: "all", label: text("own.otherTools.filter.all") },
                      { value: "codex", label: TOOL_NAME.codex },
                      { value: "claude-code", label: TOOL_NAME["claude-code"] },
                    ]}
                    onChange={(value) => setFilter("kind", value)}
                    testid="import-filter-kind"
                  />
                  <Show when={gates().allFolders}>
                    <Segmented<ListFilters["scope"]>
                      label={text("own.otherTools.filter.scope")}
                      value={filters().scope}
                      options={[
                        { value: "folder", label: text("own.otherTools.filter.folder") },
                        { value: "all", label: text("own.otherTools.filter.allFolders") },
                      ]}
                      onChange={(value) => setFilter("scope", value)}
                      testid="import-filter-scope"
                    />
                  </Show>
                  <div class="own-import-toggles" role="group" aria-label={text("own.otherTools.filter.include")}>
                    <Toggle
                      label={text("own.otherTools.filter.subagents")}
                      pressed={filters().subagents}
                      onChange={(value) => setFilter("subagents", value)}
                      testid="import-filter-subagents"
                    />
                    <Toggle
                      label={text("own.otherTools.filter.archived")}
                      pressed={filters().archived}
                      onChange={(value) => setFilter("archived", value)}
                      testid="import-filter-archived"
                    />
                    <Toggle
                      label={text("own.otherTools.filter.exec")}
                      title={text("own.otherTools.filter.execHint")}
                      pressed={filters().exec}
                      onChange={(value) => setFilter("exec", value)}
                      testid="import-filter-exec"
                    />
                  </div>
                </div>
                <div class="own-import-search">
                  <SearchField
                    label={text("own.otherTools.search.label")}
                    placeholder={text(
                      content() ? "own.otherTools.search.contentPlaceholder" : "own.otherTools.search.placeholder",
                    )}
                    clearLabel={text("own.otherTools.search.clear")}
                    initial={query()}
                    delay={QUERY_DELAY}
                    onQuery={setQuery}
                    testid="import-search"
                  />
                  <Show when={gates().search}>
                    <Toggle
                      label={text("own.otherTools.search.content")}
                      title={text("own.otherTools.search.contentHint")}
                      pressed={content()}
                      onChange={setContent}
                      testid="import-search-content"
                    />
                  </Show>
                </div>
                <Show when={list.scanning}>
                  <p class="m-0 text-[12.5px] text-own-muted" role="status" data-testid="import-scanning">
                    {text("own.otherTools.list.scanning")}
                  </p>
                </Show>
              </header>
              <div
                ref={(element) => queueMicrotask(() => setScroller(element))}
                class="own-import-scroll"
                data-testid="import-list"
                aria-busy={list.loading}
              >
                <Show when={list.error}>
                  {(message) => (
                    <p class="own-import-state" role="alert">
                      {text("own.otherTools.list.failed", { reason: message() })}{" "}
                      <button type="button" class="own-btn" data-size="sm" onClick={() => void load(false)}>
                        {text("own.otherTools.list.retry")}
                      </button>
                    </p>
                  )}
                </Show>
                <Show when={!list.loaded && list.loading}>
                  <p class="own-import-state" role="status">
                    {text("own.otherTools.list.loading")}
                  </p>
                </Show>
                <Show when={empty()}>
                  <p class="own-import-state" data-testid="import-empty">
                    {text(
                      list.items.length > 0 || query().trim()
                        ? "own.otherTools.list.emptyFiltered"
                        : "own.otherTools.list.empty",
                    )}
                  </p>
                </Show>
                <div class="own-import-rows" role="list" style={{ height: `${virtualizer.getTotalSize()}px` }}>
                  <For each={virtualizer.getVirtualItems()}>
                    {(item) => (
                      <Show when={rows()[item.index]}>
                        {(row) => (
                          <div
                            class="own-import-slot"
                            role="listitem"
                            style={{ transform: `translateY(${item.start}px)`, height: `${item.size}px` }}
                          >
                            <RowView
                              row={row()}
                              serverKey={props.serverKey}
                              projectID={props.projectID}
                              directory={folder()}
                              scope={filters().scope}
                              migrate={gates().migrate}
                              title={(ref) => known().get(refKey(ref))?.title}
                              query={query().trim()}
                              onToggle={toggleChildren}
                              onMore={() => void load(true)}
                              onSearchMore={() => void findContent(true)}
                            />
                          </div>
                        )}
                      </Show>
                    )}
                  </For>
                </div>
              </div>
            </>
          )}
        </Show>
      </Show>
    </Show>
  )
}

function rowHeight(row: DisplayRow | undefined) {
  if (!row) return HEIGHT.item
  if (row.type === "hits") return HEIGHT.group + HEIGHT.hit * Math.min(HITS_SHOWN, row.hits.length)
  return HEIGHT[row.type]
}

function RowView(props: {
  readonly row: DisplayRow
  readonly serverKey: ServerKey
  readonly projectID: string
  readonly directory: string
  readonly scope: ListFilters["scope"]
  readonly migrate: boolean
  readonly title: (ref: Hit["ref"]) => string | undefined
  readonly query: string
  readonly onToggle: (key: string) => void
  readonly onMore: () => void
  readonly onSearchMore: () => void
}) {
  const text = useImportText()
  return (
    <Switch>
      <Match when={props.row.type === "folder" && props.row}>
        {(row) => (
          <div class="own-import-folder" data-testid="import-folder" title={row().cwd}>
            <span class="min-w-0 truncate font-mono">{row().cwd}</span>
            <Show when={row().otherComputer}>
              <Tag tone="soft">{text("own.otherTools.group.otherComputer")}</Tag>
            </Show>
            <Show when={!row().exists && !row().otherComputer}>
              <Tag tone="dashed">{text("own.otherTools.group.missing")}</Tag>
            </Show>
            <span class="own-num ml-auto flex-none">{text("own.otherTools.group.count", { n: row().count })}</span>
          </div>
        )}
      </Match>
      <Match when={props.row.type === "item" && props.row}>
        {(row) => (
          <ItemRow
            row={row()}
            serverKey={props.serverKey}
            projectID={props.projectID}
            directory={props.directory}
            scope={props.scope}
            migrate={props.migrate}
            onToggle={props.onToggle}
          />
        )}
      </Match>
      <Match when={props.row.type === "heading"}>
        <h3 class="own-import-heading">{text("own.otherTools.search.heading")}</h3>
      </Match>
      <Match when={props.row.type === "hits" && props.row}>
        {(row) => (
          <div class="own-import-hits" data-testid="import-hits">
            <div class="own-import-hits-title">
              <span class="min-w-0 truncate font-medium">{props.title(row().ref) || row().ref.id}</span>
              <span class="flex-none text-own-muted">{TOOL_NAME[row().ref.kind]}</span>
            </div>
            <For each={row().hits.slice(0, HITS_SHOWN)}>
              {(hit) => (
                <button
                  type="button"
                  class="own-import-hit"
                  data-testid="import-hit"
                  onClick={() =>
                    openImport({
                      serverKey: props.serverKey,
                      projectID: props.projectID,
                      ref: routeRef(hit.ref),
                      turn: hit.turn,
                    })
                  }
                >
                  <span class="own-num flex-none text-own-muted">
                    {text("own.otherTools.search.turn", { n: hit.turn + 1 })}
                  </span>
                  <span class="min-w-0 truncate">{hit.snippet}</span>
                </button>
              )}
            </For>
          </div>
        )}
      </Match>
      <Match when={props.row.type === "status" && props.row}>
        {(row) => (
          <div class="own-import-status" data-testid={`import-status-${row().kind}`}>
            <Switch>
              <Match when={row().kind === "more"}>
                <button type="button" class="own-btn" data-size="sm" onClick={() => props.onMore()}>
                  {text("own.otherTools.list.more")}
                </button>
              </Match>
              <Match when={row().kind === "loading"}>
                <span role="status">{text("own.otherTools.list.loading")}</span>
              </Match>
              <Match when={row().kind === "searching"}>
                <span role="status">{text("own.otherTools.search.searching")}</span>
              </Match>
              <Match when={row().kind === "partial"}>
                <button
                  type="button"
                  class="own-btn"
                  data-size="sm"
                  data-testid="import-search-more"
                  onClick={() => props.onSearchMore()}
                >
                  {text("own.otherTools.search.partial")}
                </button>
              </Match>
              <Match when={row().kind === "none"}>
                <span>{text("own.otherTools.search.none", { query: props.query })}</span>
              </Match>
            </Switch>
          </div>
        )}
      </Match>
    </Switch>
  )
}

const TAG_TONE: { readonly [K in RowTag["kind"]]: "default" | "soft" | "warn" | "dashed" | "accent" } = {
  imported: "accent",
  newTurns: "default",
  live: "warn",
  folderMissing: "dashed",
  unreadable: "warn",
  expires: "warn",
  archived: "soft",
  exec: "soft",
  otherComputer: "soft",
}

function ItemRow(props: {
  readonly row: Extract<ListRow, { type: "item" }>
  readonly serverKey: ServerKey
  readonly projectID: string
  readonly directory: string
  readonly scope: ListFilters["scope"]
  readonly migrate: boolean
  readonly onToggle: (key: string) => void
}) {
  const i18n = useI18n()
  const text = useImportText()
  const summary = () => props.row.summary
  const title = () => summary().title.trim() || text("own.otherTools.row.untitled")
  const target = () => ({
    name: "import" as const,
    serverKey: props.serverKey,
    projectID: props.projectID,
    ref: routeRef(summary().ref),
  })
  const tags = createMemo(() => rowTags(summary(), minuteNow()))
  const expires = createMemo(() => expiry(summary(), minuteNow()))
  const model = () => lastModel(summary())
  // Q3: the tag shows from EXPIRY_TAG_DAYS left; until then the row's tooltip says it (phase note (b)).
  const tooltip = () => {
    const left = expires()
    return left ? text("own.otherTools.tag.expiresHint", { days: CLAUDE_CLEANUP_DAYS, n: left.days }) : undefined
  }
  return (
    <div
      class="own-import-row"
      data-testid="import-row"
      data-kind={summary().ref.kind}
      data-child={props.row.child ? "" : undefined}
      data-readable={summary().readable ? undefined : "false"}
      title={tooltip()}
    >
      <div class="own-import-row-line">
        <Show when={summary().readable} fallback={<span class="own-import-row-title">{title()}</span>}>
          <RouteLink to={target()} class="own-import-row-title" data-testid="import-row-title">
            {title()}
          </RouteLink>
        </Show>
        <span class="own-import-row-meta">
          <span>{TOOL_NAME[summary().ref.kind]}</span>
          <span aria-hidden="true">·</span>
          <span class="own-num">{relativeTime(i18n, minuteNow(), summary().updatedAt)}</span>
          <Show when={model()}>
            {(name) => (
              <>
                <span aria-hidden="true">·</span>
                <span class="min-w-0 truncate" data-testid="import-row-model">
                  {text("own.otherTools.row.model", { model: name() })}
                </span>
              </>
            )}
          </Show>
        </span>
      </div>
      <p class="own-import-row-prompt" data-testid="import-row-prompt">
        {summary().firstPrompt ?? ""}
      </p>
      <div class="own-import-row-line">
        <span class="own-import-tags">
          <For each={tags()}>{(tag) => <RowTagView tag={tag} problem={summary().problem} />}</For>
          <Show when={props.row.children > 0}>
            <button
              type="button"
              class="own-import-fold"
              aria-expanded={props.row.open}
              data-testid="import-row-children"
              onClick={() => props.onToggle(props.row.key)}
            >
              <span aria-hidden="true">{props.row.open ? "▾" : "▸"}</span>
              {props.row.open
                ? text("own.otherTools.row.subagentsHide")
                : text("own.otherTools.row.subagentsShow", { n: props.row.children })}
            </button>
          </Show>
          <Show when={props.row.children === 0 && summary().subagents > 0}>
            <Tag tone="plain">{text("own.otherTools.row.subagents", { n: summary().subagents })}</Tag>
          </Show>
        </span>
        <span class="own-import-actions">
          <Show when={summary().readable}>
            <RouteLink
              to={target()}
              class="own-btn"
              data-size="sm"
              aria-label={text("own.otherTools.row.openTitle", { title: title() })}
              data-testid="import-row-open"
            >
              {text("own.otherTools.row.open")}
            </RouteLink>
          </Show>
          <Show when={props.migrate && summary().readable && !props.row.child}>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              data-testid="import-row-resume"
              onClick={() =>
                requestMigrate({
                  serverKey: props.serverKey,
                  projectID: props.projectID,
                  directory: props.directory,
                  ref: routeRef(summary().ref),
                  ...(props.scope === "all" ? { location: props.directory } : {}),
                  ...(model() ? { original: model() } : {}),
                })
              }
            >
              {text(props.scope === "all" ? "own.otherTools.row.importHere" : "own.otherTools.row.resume")}
            </button>
          </Show>
        </span>
      </div>
    </div>
  )
}

const PROBLEM: { readonly [K in NonNullable<Summary["problem"]>]: ImportKey } = {
  missing: "own.otherTools.problem.missing",
  decode_failed: "own.otherTools.problem.decode_failed",
  too_large: "own.otherTools.problem.too_large",
  path_denied: "own.otherTools.problem.path_denied",
  locked: "own.otherTools.problem.locked",
}

function RowTagView(props: { readonly tag: RowTag; readonly problem: Summary["problem"] }) {
  const text = useImportText()
  const view = (): { label: string; title?: string } => {
    const tag = props.tag
    switch (tag.kind) {
      case "imported":
        return { label: text("own.otherTools.tag.imported") }
      case "newTurns":
        return { label: text("own.otherTools.tag.newTurns", { n: tag.n }) }
      case "live":
        return { label: text("own.otherTools.tag.live"), title: text("own.otherTools.tag.liveHint") }
      case "folderMissing":
        return { label: text("own.otherTools.tag.folderMissing"), title: text("own.otherTools.tag.folderMissingHint") }
      case "unreadable":
        return {
          label: text("own.otherTools.tag.unreadable"),
          title: tag.problem ? text(PROBLEM[tag.problem]) : undefined,
        }
      case "expires":
        return {
          label:
            tag.days > 0 ? text("own.otherTools.tag.expires", { n: tag.days }) : text("own.otherTools.tag.expiresSoon"),
          title: text("own.otherTools.tag.expiresHint", { days: CLAUDE_CLEANUP_DAYS, n: tag.days }),
        }
      case "archived":
        return { label: text("own.otherTools.tag.archived") }
      case "exec":
        return { label: text("own.otherTools.tag.exec") }
      case "otherComputer":
        return { label: text("own.otherTools.tag.otherComputer") }
    }
  }
  return (
    <Tag tone={TAG_TONE[props.tag.kind]} title={view().title} testid={`import-tag-${props.tag.kind}`}>
      {view().label}
    </Tag>
  )
}

/** A filter that is on or off (`aria-pressed`). */
export function Toggle(props: {
  readonly label: string
  readonly title?: string
  readonly pressed: boolean
  readonly onChange: (pressed: boolean) => void
  readonly testid?: string
}) {
  return (
    <button
      type="button"
      class="own-import-toggle"
      aria-pressed={props.pressed}
      title={props.title}
      data-testid={props.testid}
      onClick={() => props.onChange(!props.pressed)}
    >
      {props.label}
    </button>
  )
}

/**
 * A search input under 03 §12: uncontrolled (never written while composing), `onQuery` gets the value `delay` ms after
 * the last input, Enter applies at once (the Enter that commits Hangul only commits, rule 8's exception), Esc clears.
 */
export function SearchField(props: {
  readonly label: string
  readonly placeholder: string
  readonly clearLabel: string
  readonly initial?: string
  readonly delay: number
  readonly onQuery: (value: string) => void
  readonly onEscape?: () => void
  readonly autofocus?: boolean
  readonly testid?: string
}) {
  let input!: HTMLInputElement
  const [value, setValue] = createSignal(props.initial ?? "")
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelFrame: (() => void) | undefined
  onCleanup(() => {
    clearTimeout(timer)
    cancelFrame?.()
  })
  const apply = (next: string) => {
    clearTimeout(timer)
    props.onQuery(next)
  }
  // The input handler only records the value (R6); the query waits for a pause in typing.
  const schedule = (next: string) => {
    cancelFrame?.()
    cancelFrame = nextFrame(() => {
      setValue(next)
      clearTimeout(timer)
      timer = setTimeout(() => props.onQuery(next), props.delay)
    })
  }
  const ime = createImeEnter({ commitOnly: true, onEnter: () => apply(input.value) })
  const clear = () => {
    cancelFrame?.()
    clearNextFrame(input, () => {
      setValue("")
      apply("")
    })
  }
  onMount(() => {
    input.value = props.initial ?? ""
    if (props.autofocus) input.focus()
  })
  return (
    <div class="own-import-searchbox" role="search">
      <svg viewBox="0 0 24 24" aria-hidden="true" class="size-3.5 flex-none fill-none stroke-current stroke-[1.8]">
        <path d="M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4" />
      </svg>
      <input
        ref={input}
        type="text"
        role="searchbox"
        enterkeyhint="search"
        autocomplete="off"
        spellcheck={false}
        aria-label={props.label}
        placeholder={props.placeholder}
        data-testid={props.testid}
        onKeyDown={(event) => {
          const handled = ime.keydown(event)
          if (!handled && !event.isComposing && event.keyCode !== 229 && event.code === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            if (input.value) return clear()
            props.onEscape?.()
          }
          inputSampler.record(event)
        }}
        onKeyUp={(event) => ime.keyup(event)}
        onCompositionStart={(event) => {
          ime.compositionstart()
          inputSampler.record(event)
        }}
        onCompositionEnd={(event) => {
          ime.compositionend()
          inputSampler.record(event)
        }}
        onInput={(event) => {
          ime.input()
          schedule(event.currentTarget.value)
          inputSampler.record(event)
        }}
      />
      <Show when={value()}>
        <button
          type="button"
          class="own-icon-button own-target size-6 [&_svg]:size-3 [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:stroke-2"
          aria-label={props.clearLabel}
          onClick={() => {
            clear()
            input.focus()
          }}
        >
          <Icon name="x" />
        </button>
      </Show>
    </div>
  )
}
