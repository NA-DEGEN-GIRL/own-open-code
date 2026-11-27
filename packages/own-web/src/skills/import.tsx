// Skills popover, `가져오기` view (03 §19.6.1, 09 §9), a lazy chunk of the skills panel and of 설정 > 스킬: the skills
// Codex and Claude Code installed on this PC, each with its status (`이미 쓰는 중`, `이 앱에 있음`, `원본이 바뀜`,
// `형식이 맞지 않음` with the reasons, `가져올 수 있음`) and `이 앱에서 쓰기`, which copies the folder into own's skills
// folder (`skills.import`). A name own already has asks for another name, or offers `바꾸기` for own-import's own copy;
// a skill with executable files asks for trust first. `업데이트 확인` compares every copy with its source
// (`skills.updates`), and `URL로 설치…` previews a git repository (`skills.preview`: the file list and the manifests
// only) before the user confirms the install (`skills.install`). Listing is `read`; everything that copies, downloads
// or checks the network is `local`, so a phone sees the list only (09 §9.6).
//
// SK2 (2026-10-24): the head says where it looked (each root by a readable name, `찾을 곳 더하기`), one row stands for
// every identical copy (`N곳에서 찾음`), copies of the same name with other content are `내용이 다름`, a search and the
// filters narrow the list, bundled skills hide behind `기본 제공도 보기`, a link outside the roots waits for its
// checkbox (`이 폴더의 파일을 복사해서 가져오기`, the list is read again through it), and `상세 보기` opens the detail
// (./detail, its own lazy chunk) in place of the list.
//
// SG (2026-10-26): a select on top says where the copies are used, `모든 프로젝트` (the default: own's skills folder is
// read in every project) or `이 프로젝트만 (name)` (when the view knows its project). The copy's folder
// (`<skills folder>\<id>`) gets that place before the skill is copied (own.accounts `skillset.switch`), so no other
// project ever lists it: the scope for one project, or none for every project (a scope a deleted folder left behind
// goes, SG-21), and a scope inside the folder goes too; a failed copy puts the scopes back as they were. A copy that
// replaces one of the same name (`바꾸기`) gets the chosen place as well and its toast says so (SG-20); only
// `다시 가져오기` of an existing copy keeps its place.
import { createEffect, createMemo, createResource, createSignal, For, lazy, Show, Suspense } from "solid-js"
import { formatSize } from "@/attachments/model"
import type { ServerRuntime } from "@/data"
import { OwnRpcError } from "@/data/rpc"
import { baseName, pathSep, samePath } from "@/projects/path"
import { useRouter } from "@/routing/router"
import { showToast } from "@/switcher/toast"
import { isInside } from "@/worktree/model"
import type { DetailPlace } from "./detail"
import {
  FILTERS,
  groupRows,
  loadedConflict,
  lookedIn,
  mergeFound,
  pendingUpdates,
  shortCommit,
  shownPath,
  sourcesOf,
  suggestID,
  validSkillID,
  visibleRows,
  type Candidate,
  type ClaudeAccount,
  type FoundSkill,
  type ImportFilter,
  type Label,
  type LoadedSkill,
  type Preview,
  type SkillLink,
  type SkillRecord,
  type SkillRow,
} from "./import-model"
import { useSkillsImportText, type SkillsImportKey } from "./import-strings"

const SkillDetail = lazy(() => import("./detail"))

export interface SkillsImportProps {
  readonly runtime: ServerRuntime
  /**
   * The skills own loads for the panel's folder (`이미 쓰는 중`, name conflicts); `undefined` until core answered
   * (SK2 2026-10-25: the rows wait as `확인 중…`, nothing is offered before).
   */
  readonly loaded: () => ReadonlyArray<LoadedSkill> | undefined
  /** That folder: the list compares what core loads there by content (`skills.list{directory}`). */
  readonly directory?: () => string | undefined
  /** Under 설정 > 스킬's own heading: no title of its own (SK2). */
  readonly embedded?: boolean
  /** The view sends the user elsewhere (`찾을 곳 더하기`): the popover closes. */
  readonly onLeave?: () => void
  /** A skill was copied or installed (설정 > 스킬 reads its switches and scopes again). */
  readonly onChanged?: () => void
}

/**
 * Where the copies are used (SG): `directory` (one project) or `null` (every project), set on the copies' folders
 * before the copy. `before` holds the scopes the change touched as they were, to put back when the copy fails.
 */
interface Placement {
  readonly directory: string | null
  readonly before: ReadonlyArray<{ readonly folder: string; readonly directory: string | null }>
}

/**
 * Gives `folders` the place `directory` (`null`: every project), and clears every scope inside them (an earlier copy's,
 * SG-21). Writes nothing when every scope already says so. Throws when own.accounts refuses.
 */
async function place(runtime: ServerRuntime, folders: ReadonlyArray<string>, directory: string | null) {
  const view = await runtime.rpc.call("skillset.view", {})
  const inside = view.scopes.filter((scope) =>
    folders.some((folder) => isInside(folder, scope.folder) && !samePath(folder, scope.folder)),
  )
  const next = [
    ...folders.map((folder) => ({ folder, directory })),
    ...inside.map((scope) => ({ folder: scope.folder, directory: null })),
  ]
  const before = next.map((item) => ({
    folder: item.folder,
    directory: view.scopes.find((scope) => samePath(scope.folder, item.folder))?.directory ?? null,
  }))
  if (before.every((item, index) => sameDirectory(item.directory, next[index]!.directory)))
    return { directory, before: [] }
  await runtime.rpc.call("skillset.switch", { changes: [], scopes: next })
  return { directory, before }
}

function sameDirectory(a: string | null, b: string | null) {
  return a === null || b === null ? a === b : samePath(a, b)
}

/** Puts the scopes back as they were before a copy that failed. */
async function unplace(runtime: ServerRuntime, placement: Placement | undefined) {
  if (placement === undefined || placement.before.length === 0) return
  await runtime.rpc
    .call("skillset.switch", { changes: [], scopes: [...placement.before] })
    .catch((error: unknown) => console.error("[own-web] skillset.switch", error))
}

/** The folder own-import copies skill `id` into. */
function copyFolder(skillsDir: string, id: string) {
  const sep = pathSep(skillsDir)
  return `${skillsDir.replace(/[\\/]+$/, "")}${sep}${id}`
}

type Updates = ReturnType<typeof pendingUpdates>

/** What the row of `key` asks before it imports: trust for executable files, or another name. */
type Pending =
  | { readonly key: string; readonly step: "trust" }
  | {
      readonly key: string
      readonly step: "conflict"
      readonly id: string
      readonly taken: string
      readonly replaceable: boolean
      readonly loaded: boolean
    }

interface Repo {
  readonly url: string
  readonly ref?: string
  readonly folder?: string
}

export default function SkillsImport(props: SkillsImportProps) {
  const text = useSkillsImportText()
  const router = useRouter()
  const rpc = props.runtime.imports
  const local = () => rpc.allowed("skills.import")
  /** Links outside the roots the user approved in this view; the list is read again through them. */
  const [approved, setApproved] = createSignal<ReadonlySet<string>>(new Set())
  const [listing, { refetch }] = createResource(
    () => ({ keys: [...approved()].toSorted(), directory: props.directory?.() }),
    (ask) =>
      rpc.call("skills.list", {
        ...(ask.keys.length ? { approvedLinks: ask.keys } : {}),
        ...(ask.directory ? { directory: ask.directory } : {}),
      }),
  )
  // `latest` throws the read's error (own-import not running, a failed scan): the rows then stay empty and the error
  // line below says why, instead of the whole view breaking (MR13).
  const listed = () => (listing.error ? undefined : listing.latest)
  const [pending, setPending] = createSignal<Pending>()
  const [trusted, setTrusted] = createSignal<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = createSignal<string>()
  const [updates, setUpdates] = createSignal<Updates | "checking">()
  const [repo, setRepo] = createSignal<Repo | "open">()
  const [query, setQuery] = createSignal("")
  const [filter, setFilter] = createSignal<ImportFilter>("all")
  const [source, setSource] = createSignal<string>()
  const [builtins, setBuiltins] = createSignal(false)
  const [detail, setDetail] = createSignal<SkillRow>()
  /** `가져올 스킬을 쓸 곳` (SG): every project, or only the view's project. */
  const [target, setTarget] = createSignal<"all" | "here">("all")
  const scopes = () => props.runtime.kind !== "ssh" && props.runtime.rpc.allowed("skillset.switch")
  /** The project the copies are kept in, when `이 프로젝트만` is chosen and the view knows it. */
  const placeIn = () => (scopes() && target() === "here" ? props.directory?.() : undefined)
  createEffect(() => {
    if (!props.directory?.()) setTarget("all")
  })
  const label = (value: Label) => text(value.key, value.params)
  let view: HTMLDivElement | undefined
  /** Opens the detail in place of the list, its top in sight (설정 > 스킬 scrolls the page, the popover the view). */
  const showDetail = (row: SkillRow | undefined) => {
    setDetail(row)
    requestAnimationFrame(() => view?.scrollIntoView({ block: "nearest" }))
    if (view) view.scrollTop = 0
  }
  /** own's Claude accounts with their uuids: the names of the Claude app's synced folders. */
  const accounts = createMemo((): ClaudeAccount[] =>
    Object.values(props.runtime.own.state.accounts).flatMap((account) =>
      account?.kind === "claude-sub" && account.claude?.accountUuid
        ? [{ label: account.label, uuid: account.claude.accountUuid }]
        : [],
    ),
  )
  const rows = createMemo(() =>
    mergeFound({
      items: listed()?.items ?? [],
      roots: listed()?.roots ?? [],
      loaded: props.loaded(),
      imports: listed()?.imports ?? [],
      accounts: accounts(),
      twins: listed()?.loaded ?? [],
      directory: props.directory?.(),
    }),
  )
  const visible = createMemo(() =>
    visibleRows(rows(), {
      query: query(),
      filter: filter(),
      builtins: builtins(),
      source: source(),
      label: (place) => label(place.label),
    }),
  )
  const groups = createMemo(() => groupRows(visible().rows))
  const places = createMemo(() => lookedIn(listed()?.roots ?? [], rows()))
  const taken = () => [
    ...(props.loaded() ?? []).map((item) => item.id),
    ...(listed()?.imports ?? []).map((item) => item.id),
  ]
  /** This row's approved link keys: what `skills.import` and `skills.detail` read it through. */
  const keysOf = (item: FoundSkill) =>
    (item.links ?? []).flatMap((link) => (link.linkKey && approved().has(link.linkKey) ? [link.linkKey] : []))

  function use(row: SkillRow) {
    const item = row.item
    const loaded = props.loaded()
    if (!local() || busy() || loaded === undefined) return
    const conflict = loadedConflict(item.id, item.directory, loaded)
    if (conflict)
      return setPending({
        key: item.key,
        step: "conflict",
        id: suggestID(item.id, item.origin, taken()),
        taken: item.id,
        replaceable: false,
        loaded: true,
      })
    if (item.scripts.length > 0 && !trusted().has(item.key)) return setPending({ key: item.key, step: "trust" })
    void copy(item, item.id, "new")
  }

  /**
   * Copies a found skill as `id`: `new`, `replace` (`바꾸기` of a copy of that name) and `update` (`다시 가져오기` of a
   * copy). A new or replacing copy gets the chosen place first (SG-20); an update keeps the place its copy has. A new
   * copy whose id an earlier copy has gets no place: own-import refuses it (`skill_conflict`), and placing first would
   * move the earlier copy's scope until the refusal put it back.
   */
  async function copy(item: FoundSkill, id: string, how: "new" | "replace" | "update") {
    const replace = how !== "new"
    setBusy(item.key)
    const skillsDir = listed()?.directory
    const copied = how === "new" && (listed()?.imports ?? []).some((record) => record.id === id)
    const placed =
      how === "update" || copied || !scopes() || !skillsDir
        ? undefined
        : await place(props.runtime, [copyFolder(skillsDir, id)], placeIn() ?? null).catch((error: unknown) => {
            console.error("[own-web] skillset.switch", error)
            return null
          })
    if (placed === null) {
      setBusy(undefined)
      showToast({ tone: "danger", message: text("own.skills.import.failedOne", { name: item.name }) })
      return
    }
    try {
      const links = keysOf(item)
      const done = await rpc.call("skills.import", {
        key: item.key,
        ...(id === item.id ? {} : { id }),
        ...(replace ? { replace } : {}),
        ...(links.length ? { approvedLinks: links } : {}),
      })
      setPending(undefined)
      showToast({ message: copiedText(how, placed?.directory, done.id) })
      void refetch()
      props.onChanged?.()
    } catch (error) {
      await unplace(props.runtime, placed)
      if (error instanceof OwnRpcError && error.type === "skill_conflict") {
        const data = error.data as { readonly id?: string; readonly replaceable?: boolean } | undefined
        setPending({
          key: item.key,
          step: "conflict",
          id: suggestID(data?.id ?? id, item.origin, taken()),
          taken: data?.id ?? id,
          replaceable: data?.replaceable === true,
          loaded: false,
        })
        return
      }
      if (error instanceof OwnRpcError && error.type === "skill_links") {
        showToast({ tone: "danger", message: text("own.skills.import.linkChanged") })
        void refetch()
        return
      }
      console.error("[own-web] skills.import", error)
      showToast({ tone: "danger", message: text("own.skills.import.failedOne", { name: item.name }) })
    } finally {
      setBusy(undefined)
    }
  }

  async function runUpdates() {
    setUpdates("checking")
    const found = await rpc.call("skills.updates", {}).then(
      (answer) => pendingUpdates(answer.items),
      (error: unknown) => {
        console.error("[own-web] skills.updates", error)
        return undefined
      },
    )
    setUpdates(found)
    if (found === undefined) showToast({ tone: "danger", message: text("own.skills.import.failed") })
  }

  /** `다시 가져오기` from the updates list: a local source by its key, a git source through a new preview. */
  function update(entry: Updates[number]) {
    const record = listed()?.imports.find((item) => item.id === entry.id)
    if (record === undefined) return
    if (record.origin === "git") return setRepo(recordRepo(record))
    const item = listed()?.items.find((found) => found.key === entry.key)
    if (item) void copy(item, record.id, "update")
  }

  /** The toast of a copy: where it is used now when it was placed (SG-20). */
  function copiedText(how: "new" | "replace" | "update", where: string | null | undefined, id: string) {
    if (how === "update" || (how === "replace" && where === undefined)) return text("own.skills.import.done", { id })
    if (where)
      return text(how === "new" ? "own.skills.import.doneHere" : "own.skills.import.replacedHere", {
        project: baseName(where),
        id,
      })
    return text(how === "new" ? "own.skills.import.doneAll" : "own.skills.import.replacedAll", { id })
  }

  function approve(link: SkillLink, on: boolean) {
    const key = link.linkKey
    if (!key) return
    setApproved((set) => {
      const next = new Set(set)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }

  /** The detail's places: every place of the row, the shown one first. */
  const detailPlaces = (row: SkillRow): DetailPlace[] =>
    row.places.flatMap((place, index) => [
      {
        label: label(place.source.label),
        path: place.item.directory,
        ...(place.item.modifiedAt ? { modifiedAt: place.item.modifiedAt } : {}),
        ...(place.item.version ? { version: place.item.version } : {}),
        ...(index === 0 ? { main: true } : {}),
      },
      ...place.aliases.map((alias) => ({ label: label(place.source.label), path: alias.directory, alias: true })),
    ])

  return (
    <div ref={view} class="own-sk-imp" data-testid="skills-import" data-embedded={props.embedded ? "" : undefined}>
      <Show
        when={detail()}
        fallback={
          <>
            <div class="own-sk-imp-head">
              {/* 설정 > 스킬 has its own heading over the view (SK2: one heading, not two). */}
              <span class="own-sk-imp-title">{props.embedded ? "" : text("own.skills.import.title")}</span>
              <Show when={local() && scopes()}>
                <label class="own-sk-imp-target">
                  <span>{text("own.skills.import.target")}</span>
                  <select
                    class="own-sk-search own-sk-imp-source"
                    data-testid="skills-import-target"
                    value={target()}
                    onChange={(event) => setTarget(event.currentTarget.value === "here" ? "here" : "all")}
                  >
                    <option value="all" selected={target() === "all"}>
                      {text("own.skills.import.target.all")}
                    </option>
                    <Show when={props.directory?.()}>
                      {(directory) => (
                        <option value="here" selected={target() === "here"}>
                          {text("own.skills.import.target.here", { name: baseName(directory()) })}
                        </option>
                      )}
                    </Show>
                  </select>
                </label>
              </Show>
              <Show when={local()}>
                <button
                  type="button"
                  class="own-sk-btn"
                  data-testid="skills-import-updates"
                  disabled={updates() === "checking" || !listed()?.imports.length}
                  onClick={() => void runUpdates()}
                >
                  {text("own.skills.import.updates")}
                </button>
                <button
                  type="button"
                  class="own-sk-btn"
                  data-testid="skills-import-url"
                  aria-expanded={repo() !== undefined}
                  onClick={() => setRepo((current) => (current === undefined ? "open" : undefined))}
                >
                  {text("own.skills.import.url")}
                </button>
              </Show>
            </div>
            <Show when={!local()}>
              <p class="own-sk-state">{text("own.skills.import.localOnly")}</p>
            </Show>
            <Show when={listed()?.directory === null}>
              <p class="own-sk-state" data-tone="danger">
                {text("own.skills.import.unconfigured")}
              </p>
            </Show>
            <Show when={places().length}>
              <div class="own-sk-imp-places" data-testid="skills-import-places">
                <span class="own-sk-imp-places-title">{text("own.skills.import.lookedIn")}</span>
                <ul class="own-sk-imp-place-list">
                  <For each={places()}>
                    {(place) => (
                      <li
                        class="own-sk-imp-place"
                        data-testid="skills-import-place"
                        data-root={place.root.rootID}
                        data-state={place.state}
                        title={place.root.directory}
                      >
                        <span class="own-sk-imp-place-name">{label(place.label)}</span>
                        <Show
                          when={place.state}
                          fallback={
                            <span class="own-sk-imp-place-count">
                              {text("own.skills.import.place.count", { n: place.count })}
                            </span>
                          }
                        >
                          {(state) => (
                            <span class="own-sk-imp-place-state" data-testid="skills-import-place-state">
                              {"· "}
                              {state() === "shared"
                                ? text("own.skills.import.place.shared", {
                                    name: place.shared ? label(place.shared) : "",
                                  })
                                : state() === "elsewhere"
                                  ? text("own.skills.import.place.elsewhere", { path: place.root.skillsTarget ?? "" })
                                  : text(
                                      `own.skills.import.place.${state() as "missing" | "unreadable" | "path_denied"}`,
                                    )}
                            </span>
                          )}
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
                <Show when={rpc.allowed("sources.configure")}>
                  <button
                    type="button"
                    class="own-sk-link"
                    data-testid="skills-import-add-place"
                    onClick={() => {
                      props.onLeave?.()
                      router.navigate({ name: "settings", section: "import" })
                    }}
                  >
                    {text("own.skills.import.addPlace")}
                  </button>
                </Show>
              </div>
            </Show>
            <Show when={repo()} keyed>
              {(current) => (
                <UrlInstall
                  runtime={props.runtime}
                  start={current === "open" ? undefined : current}
                  taken={taken}
                  scopes={scopes}
                  placeIn={placeIn}
                  skillsDir={() => listed()?.directory ?? undefined}
                  onInstalled={() => {
                    setRepo(undefined)
                    setUpdates(undefined)
                    void refetch()
                    props.onChanged?.()
                  }}
                />
              )}
            </Show>
            <Show when={updates()}>
              {(state) => (
                <div class="own-sk-imp-updates" data-testid="skills-import-updates-result">
                  <Show
                    when={state() !== "checking"}
                    fallback={<p class="own-sk-state">{text("own.skills.import.updatesChecking")}</p>}
                  >
                    <Show
                      when={(state() as Updates).length > 0}
                      fallback={<p class="own-sk-state">{text("own.skills.import.updatesNone")}</p>}
                    >
                      <ul class="own-sk-imp-list">
                        <For each={state() as Updates}>
                          {(entry) => (
                            <li class="own-sk-imp-row" data-skill={entry.id}>
                              <span class="own-sk-line">
                                <code class="own-sk-id">@{entry.id}</code>
                                <span class="own-sk-tag" data-tone={entry.state === "changed" ? "warn" : undefined}>
                                  {text(
                                    `own.skills.import.update.${entry.state as "changed" | "source_missing" | "unknown"}`,
                                  )}
                                </span>
                                <Show when={entry.state === "changed"}>
                                  <button type="button" class="own-sk-link" onClick={() => update(entry)}>
                                    {entry.key
                                      ? text("own.skills.import.reimport")
                                      : text("own.skills.import.update.view")}
                                  </button>
                                </Show>
                              </span>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </Show>
                </div>
              )}
            </Show>
            <Show
              when={!listing.loading || listed()}
              fallback={<p class="own-sk-state">{text("own.skills.import.loading")}</p>}
            >
              <Show
                when={!listing.error}
                fallback={
                  <p class="own-sk-state" data-tone="danger">
                    {text("own.skills.import.failed")}{" "}
                    <button type="button" class="own-sk-link" onClick={() => void refetch()}>
                      {text("own.skills.retry")}
                    </button>
                  </p>
                }
              >
                <Show when={rows().length} fallback={<p class="own-sk-state">{text("own.skills.import.none")}</p>}>
                  <div class="own-sk-imp-tools" data-testid="skills-import-tools">
                    <input
                      class="own-sk-search own-sk-imp-grow"
                      type="search"
                      value={query()}
                      placeholder={text("own.skills.search")}
                      aria-label={text("own.skills.search")}
                      spellcheck={false}
                      autocomplete="off"
                      data-testid="skills-import-search"
                      onInput={(event) => setQuery(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        // The Enter that commits an IME composition only commits (03 §12).
                        if (event.key === "Enter" && event.isComposing) event.preventDefault()
                      }}
                    />
                    <Show when={sourcesOf(rows()).length > 1}>
                      <select
                        class="own-sk-search own-sk-imp-source"
                        aria-label={text("own.skills.import.source.label")}
                        data-testid="skills-import-source"
                        onChange={(event) => setSource(event.currentTarget.value || undefined)}
                      >
                        <option value="" selected={source() === undefined}>
                          {text("own.skills.import.source.all")}
                        </option>
                        <For each={sourcesOf(rows())}>
                          {(entry, index) => (
                            <option value={entry.key} selected={source() === entry.key} data-index={index()}>
                              {label(entry.label)}
                            </option>
                          )}
                        </For>
                      </select>
                    </Show>
                  </div>
                  <div
                    class="own-sk-imp-filters"
                    role="group"
                    aria-label={text("own.skills.import.filter.label")}
                    data-testid="skills-import-filters"
                  >
                    <For each={FILTERS}>
                      {(entry) => (
                        <button
                          type="button"
                          class="own-sk-chip"
                          aria-pressed={filter() === entry}
                          data-testid={`skills-import-filter-${entry}`}
                          onClick={() => setFilter(entry)}
                        >
                          {text(`own.skills.import.filter.${entry}`)}
                        </button>
                      )}
                    </For>
                    <label class="own-sk-imp-check own-sk-imp-builtins">
                      <input
                        type="checkbox"
                        checked={builtins()}
                        data-testid="skills-import-builtins"
                        onChange={(event) => setBuiltins(event.currentTarget.checked)}
                      />
                      {text("own.skills.import.builtins")}
                    </label>
                    <Show when={visible().hidden}>
                      <span class="own-sk-imp-note" data-testid="skills-import-hidden">
                        {text("own.skills.import.builtinsHidden", { n: visible().hidden })}
                      </span>
                    </Show>
                  </div>
                  <Show
                    when={groups().length}
                    fallback={
                      <p class="own-sk-state" data-testid="skills-import-nomatch">
                        {text("own.skills.import.noMatch")}
                      </p>
                    }
                  >
                    <div class="own-sk-imp-body">
                      <For each={groups()}>
                        {(group) => (
                          <section
                            class="own-sk-imp-group"
                            aria-label={label(group.source.label)}
                            data-testid="skills-import-group"
                            data-source={group.source.key}
                          >
                            <h3 class="own-sk-imp-group-title" title={group.source.directory}>
                              {label(group.source.label)} · {group.rows.length}
                            </h3>
                            <ul class="own-sk-imp-list">
                              <For each={group.rows}>
                                {(row) => (
                                  <FoundRow
                                    row={row}
                                    label={label}
                                    local={local() && listed()?.directory !== null}
                                    busy={busy() === row.item.key}
                                    approved={approved()}
                                    pending={pending()?.key === row.item.key ? pending() : undefined}
                                    onUse={() => use(row)}
                                    onReimport={() => {
                                      const id = row.places.find((place) => place.item.imported)?.item.imported?.id
                                      const item = row.places.find((place) => place.item.imported)?.item ?? row.item
                                      if (id) void copy(item, id, "update")
                                    }}
                                    onApprove={approve}
                                    onDetail={() => showDetail(row)}
                                    onTrust={() => {
                                      setTrusted((set) => new Set([...set, row.item.key]))
                                      setPending(undefined)
                                      use(row)
                                    }}
                                    onRename={(id) => void copy(row.item, id, "new")}
                                    onReplace={(id) => void copy(row.item, id, "replace")}
                                    onCancel={() => setPending(undefined)}
                                  />
                                )}
                              </For>
                            </ul>
                          </section>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </Show>
            </Show>
          </>
        }
      >
        {(row) => (
          <div class="own-sk-imp-detail" data-testid="skills-import-detail">
            <span class="own-sk-actions">
              <button
                type="button"
                class="own-sk-link"
                data-testid="skills-import-detail-back"
                onClick={() => showDetail(undefined)}
              >
                ← {text("own.skills.detail.back")}
              </button>
            </span>
            <Suspense fallback={<p class="own-sk-state">{text("own.skills.detail.loading")}</p>}>
              <SkillDetail
                runtime={props.runtime}
                request={{ kind: "found", key: row().item.key, approvedLinks: keysOf(row().item) }}
                places={() => detailPlaces(row())}
              />
            </Suspense>
          </div>
        )}
      </Show>
    </div>
  )
}

function FoundRow(props: {
  readonly row: SkillRow
  readonly label: (label: Label) => string
  readonly local: boolean
  readonly busy: boolean
  readonly approved: ReadonlySet<string>
  readonly pending: Pending | undefined
  readonly onUse: () => void
  readonly onReimport: () => void
  readonly onApprove: (link: SkillLink, on: boolean) => void
  readonly onDetail: () => void
  readonly onTrust: () => void
  readonly onRename: (id: string) => void
  readonly onReplace: (id: string) => void
  readonly onCancel: () => void
}) {
  const text = useSkillsImportText()
  const item = () => props.row.item
  const status = () => props.row.status
  const count = () => props.row.places.reduce((sum, place) => sum + 1 + place.aliases.length, 0)
  const date = (at: number) => new Date(at).toLocaleDateString()
  return (
    <li
      class="own-sk-imp-row"
      data-testid="skills-import-row"
      data-skill={item().id}
      data-status={status()}
      data-differs={props.row.differs ? "" : undefined}
      data-places={count()}
    >
      <span class="own-sk-line">
        <span class="own-sk-name">{item().name}</span>
        <code class="own-sk-id">@{item().imported?.id ?? item().id}</code>
        <span
          class="own-sk-tag"
          data-tone={
            status() === "incompatible"
              ? "danger"
              : status() === "changed" || status() === "approve"
                ? "warn"
                : undefined
          }
          title={
            status() === "inUse"
              ? text(
                  props.row.inUseBy || props.row.sameAs
                    ? "own.skills.import.inUseByHint"
                    : "own.skills.import.inUseHint",
                )
              : status() === "checking"
                ? text("own.skills.import.checkingHint")
                : undefined
          }
          data-testid="skills-import-status"
        >
          {props.row.inUseBy
            ? text("own.skills.import.inUseBy", { source: props.label(props.row.inUseBy.label) })
            : text(`own.skills.import.status.${status()}`)}
        </span>
        <Show when={props.row.differs}>
          <span
            class="own-sk-tag"
            data-tone="warn"
            title={text("own.skills.import.differsHint")}
            data-testid="skills-import-differs"
          >
            {text("own.skills.import.differs")}
          </span>
          <Show when={item().version}>
            {(version) => (
              <span class="own-sk-imp-meta">{text("own.skills.import.version", { version: version() })}</span>
            )}
          </Show>
          <Show when={item().modifiedAt}>
            {(at) => <span class="own-sk-imp-meta">{text("own.skills.import.modified", { date: date(at()) })}</span>}
          </Show>
        </Show>
        <Show when={item().system}>
          <span class="own-sk-tag">{text("own.skills.import.system")}</span>
        </Show>
        <Show when={item().plugin}>
          {(plugin) => (
            <span class="own-sk-tag">
              {text("own.skills.import.plugin", { name: plugin().name })}
              {plugin().installed ? "" : ` · ${text("own.skills.import.notInstalled")}`}
            </span>
          )}
        </Show>
        <Show when={item().scripts.length}>
          <span class="own-sk-tag" data-tone="warn" title={item().scripts.join("\n")}>
            {text("own.skills.import.scripts", { n: item().scripts.length })}
          </span>
        </Show>
      </span>
      <Show when={item().description}>
        <span class="own-sk-desc">{item().description}</span>
      </Show>
      <Show when={props.row.sameAs}>
        {(id) => (
          <span class="own-sk-imp-note" data-testid="skills-import-same-as">
            {text("own.skills.import.sameAs", { id: id() })}
          </span>
        )}
      </Show>
      <code class="own-sk-imp-path" title={item().directory}>
        {shownPath(item())}
      </code>
      <For each={item().links ?? []}>
        {(link) => (
          <LinkLine
            link={link}
            approved={link.linkKey !== undefined && props.approved.has(link.linkKey)}
            local={props.local}
            onApprove={(on) => props.onApprove(link, on)}
          />
        )}
      </For>
      <Show when={count() > 1}>
        <details class="own-sk-imp-files" data-testid="skills-import-places-list">
          <summary>{text("own.skills.import.places", { n: count() })}</summary>
          <ul class="own-sk-imp-place-rows">
            <For each={props.row.places}>
              {(place, index) => (
                <>
                  <li data-testid="skills-import-place-row">
                    <span class="own-sk-line">
                      <span>{props.label(place.source.label)}</span>
                      <Show when={index() === 0}>
                        <span class="own-sk-tag">{text("own.skills.import.placeMain")}</span>
                      </Show>
                      <Show when={place.item.version}>
                        {(version) => (
                          <span class="own-sk-imp-meta">
                            {text("own.skills.import.version", { version: version() })}
                          </span>
                        )}
                      </Show>
                      <Show when={place.item.modifiedAt}>
                        {(at) => (
                          <span class="own-sk-imp-meta">
                            {text("own.skills.import.modified", { date: date(at()) })}
                          </span>
                        )}
                      </Show>
                    </span>
                    <code class="own-sk-imp-path" title={place.item.directory}>
                      {place.item.directory}
                    </code>
                  </li>
                  <For each={place.aliases}>
                    {(alias) => (
                      <li data-testid="skills-import-place-row">
                        <span class="own-sk-line">
                          <span>{props.label(place.source.label)}</span>
                          <span class="own-sk-tag">{text("own.skills.import.placeAlias")}</span>
                        </span>
                        <code class="own-sk-imp-path" title={alias.directory}>
                          {alias.directory}
                        </code>
                      </li>
                    )}
                  </For>
                </>
              )}
            </For>
          </ul>
        </details>
      </Show>
      <FormatLines format={item().format} />
      <span class="own-sk-actions">
        <Show when={props.local && (status() === "available" || status() === "changed" || status() === "checking")}>
          <Show
            when={status() === "changed"}
            fallback={
              <button
                type="button"
                class="own-sk-btn"
                data-primary
                data-testid="skills-import-use"
                disabled={props.busy || props.pending !== undefined || status() === "checking"}
                onClick={props.onUse}
              >
                {text("own.skills.import.use")}
              </button>
            }
          >
            <button type="button" class="own-sk-btn" disabled={props.busy} onClick={props.onReimport}>
              {text("own.skills.import.reimport")}
            </button>
          </Show>
        </Show>
        <button type="button" class="own-sk-btn" data-testid="skills-import-detail-open" onClick={props.onDetail}>
          {text("own.skills.detail.open")}
        </button>
      </span>
      <Show when={props.pending}>
        {(pending) => (
          <PendingBox
            pending={pending()}
            scripts={item().scripts}
            busy={props.busy}
            onTrust={props.onTrust}
            onRename={props.onRename}
            onReplace={props.onReplace}
            onCancel={props.onCancel}
          />
        )}
      </Show>
    </li>
  )
}

/** A link of a found skill (SK2): copied, waiting for the user's checkbox, or refused with its reason. */
function LinkLine(props: {
  readonly link: SkillLink
  readonly approved: boolean
  readonly local: boolean
  readonly onApprove: (on: boolean) => void
}) {
  const text = useSkillsImportText()
  const target = () => props.link.target || props.link.relative
  return (
    <span class="own-sk-imp-link" data-testid="skills-import-link" data-state={props.link.state}>
      <span class="own-sk-line">
        <code class="own-sk-imp-path" title={props.link.target}>
          {props.link.relative ? `${props.link.relative} · ` : ""}
          {text("own.skills.import.link", { target: target() })}
        </code>
        <Show when={props.link.state === "copy" && !props.link.approved}>
          <span class="own-sk-imp-note">{text("own.skills.import.link.copy")}</span>
        </Show>
        <Show when={props.link.state === "refused"}>
          <span class="own-sk-imp-problem">
            {text(`own.skills.import.link.reason.${props.link.reason ?? "denied"}`)}
          </span>
        </Show>
      </span>
      <Show when={props.link.linkKey && (props.link.state === "approve" || props.link.approved)}>
        <Show when={props.link.state === "approve"}>
          <span class="own-sk-imp-warn">{text("own.skills.import.link.approve")}</span>
        </Show>
        <label class="own-sk-imp-check">
          <input
            type="checkbox"
            checked={props.approved}
            disabled={!props.local}
            data-testid="skills-import-link-approve"
            onChange={(event) => props.onApprove(event.currentTarget.checked)}
          />
          {text(
            props.link.kind === "file" ? "own.skills.import.link.approveFile" : "own.skills.import.link.approveFolder",
          )}
        </label>
      </Show>
    </span>
  )
}

/** Problems of an incompatible skill, then the notes and the conversion (09 §9.3). */
function FormatLines(props: { readonly format: FoundSkill["format"] }) {
  const text = useSkillsImportText()
  /** `too_large` by the limit it passed (SK2 2026-10-25), the old wording when the service did not say. */
  const large = () => {
    const limit = props.format.large
    if (limit === undefined) return [text("own.skills.import.problem.too_large")]
    return [
      ...(limit.skillMd === undefined
        ? []
        : [text("own.skills.import.problem.too_large.skillMd", { size: formatSize(limit.skillMd) })]),
      ...(limit.files === undefined ? [] : [text("own.skills.import.problem.too_large.files")]),
      ...(limit.bytes === undefined
        ? []
        : [text("own.skills.import.problem.too_large.bytes", { size: formatSize(limit.bytes) })]),
      ...(limit.deep ? [text("own.skills.import.problem.too_large.deep")] : []),
    ]
  }
  const notes = () =>
    props.format.notes.map((note) =>
      note === "unknown_fields"
        ? text("own.skills.import.note.unknown_fields", { fields: props.format.ignored.join(", ") })
        : text(`own.skills.import.note.${note}`),
    )
  return (
    <>
      <Show when={props.format.problems.length}>
        <span class="own-sk-imp-problem" data-testid="skills-import-problems">
          {props.format.problems
            .flatMap((problem) => (problem === "too_large" ? large() : [text(`own.skills.import.problem.${problem}`)]))
            .join(" · ")}
        </span>
      </Show>
      <Show when={props.format.status === "converted"}>
        <span class="own-sk-imp-note">{text("own.skills.import.converted")}</span>
      </Show>
      <Show when={notes().length}>
        <span class="own-sk-imp-note">{notes().join(" · ")}</span>
      </Show>
    </>
  )
}

function PendingBox(props: {
  readonly pending: Pending
  readonly scripts: ReadonlyArray<string>
  readonly busy: boolean
  readonly onTrust: () => void
  readonly onRename: (id: string) => void
  readonly onReplace: (id: string) => void
  readonly onCancel: () => void
}) {
  const text = useSkillsImportText()
  const [agreed, setAgreed] = createSignal(false)
  const [name, setName] = createSignal(props.pending.step === "conflict" ? props.pending.id : "")
  return (
    <div class="own-sk-imp-pending" role="group" data-testid="skills-import-pending">
      <Show
        when={props.pending.step === "conflict" ? props.pending : undefined}
        fallback={
          <>
            <p class="own-sk-imp-warn">{text("own.skills.import.trust")}</p>
            <code class="own-sk-imp-path">{props.scripts.slice(0, 8).join(", ")}</code>
            <label class="own-sk-imp-check">
              <input type="checkbox" checked={agreed()} onChange={(event) => setAgreed(event.currentTarget.checked)} />
              {text("own.skills.import.trustConfirm")}
            </label>
            <span class="own-sk-actions">
              <button
                type="button"
                class="own-sk-btn"
                data-primary
                data-testid="skills-import-trust"
                disabled={!agreed() || props.busy}
                onClick={props.onTrust}
              >
                {text("own.skills.import.confirm")}
              </button>
              <button type="button" class="own-sk-btn" onClick={props.onCancel}>
                {text("own.skills.import.cancel")}
              </button>
            </span>
          </>
        }
      >
        {(conflict) => (
          <>
            <p class="own-sk-imp-warn">
              {text(
                conflict().loaded
                  ? "own.skills.import.conflictLoaded"
                  : conflict().replaceable
                    ? "own.skills.import.conflictReplace"
                    : "own.skills.import.conflict",
                { id: conflict().taken },
              )}
            </p>
            <label class="own-sk-imp-field">
              <span>{text("own.skills.import.renameLabel")}</span>
              <input
                class="own-sk-search"
                type="text"
                value={name()}
                spellcheck={false}
                autocomplete="off"
                data-testid="skills-import-rename"
                onInput={(event) => setName(event.currentTarget.value.trim())}
              />
            </label>
            <Show when={!validSkillID(name())}>
              <span class="own-sk-imp-problem">{text("own.skills.import.idInvalid")}</span>
            </Show>
            <span class="own-sk-actions">
              <button
                type="button"
                class="own-sk-btn"
                data-primary
                data-testid="skills-import-rename-go"
                disabled={!validSkillID(name()) || props.busy}
                onClick={() => props.onRename(name())}
              >
                {text("own.skills.import.rename")}
              </button>
              <Show when={conflict().replaceable}>
                <button
                  type="button"
                  class="own-sk-btn"
                  data-testid="skills-import-replace"
                  disabled={props.busy}
                  onClick={() => props.onReplace(conflict().taken)}
                >
                  {text("own.skills.import.replace")}
                </button>
              </Show>
              <button type="button" class="own-sk-btn" onClick={props.onCancel}>
                {text("own.skills.import.cancel")}
              </button>
            </span>
          </>
        )}
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// URL로 설치

function UrlInstall(props: {
  readonly runtime: ServerRuntime
  /** A repository to preview at once (`새 버전 보기`, `이 저장소 보기`). */
  readonly start: Repo | undefined
  readonly taken: () => ReadonlyArray<string>
  /** Whether the copies' place is kept (own.accounts `skillset.switch` on this PC's service). */
  readonly scopes: () => boolean
  /** The project the copies are kept in (`이 프로젝트만`, SG); `undefined`: every project. */
  readonly placeIn: () => string | undefined
  /** own's skills folder (`skills.list` `directory`). */
  readonly skillsDir: () => string | undefined
  readonly onInstalled: () => void
}) {
  const text = useSkillsImportText()
  const rpc = props.runtime.imports
  const [url, setUrl] = createSignal(props.start?.url ?? "")
  const [preview, setPreview] = createSignal<Preview>()
  const [error, setError] = createSignal<SkillsImportKey>()
  const [working, setWorking] = createSignal(false)
  const [chosen, setChosen] = createSignal<ReadonlySet<string>>(new Set())
  const [renames, setRenames] = createSignal<ReadonlyMap<string, string>>(new Map())
  const [replace, setReplace] = createSignal(false)
  const [agreed, setAgreed] = createSignal(false)

  async function look(repo: Repo) {
    setWorking(true)
    setError(undefined)
    setPreview(undefined)
    setAgreed(false)
    try {
      const found = await rpc.call("skills.preview", repo)
      setPreview(found)
      setChosen(new Set(found.items.filter((item) => selectable(item)).map((item) => item.key)))
      setRenames(
        new Map(
          found.items
            .filter((item) => item.conflict && !item.conflict.replaceable)
            .map((item) => [item.key, suggestID(item.id, "git", props.taken())]),
        ),
      )
      setReplace(found.items.some((item) => item.conflict?.replaceable))
    } catch (failure) {
      setError(previewError(failure))
    } finally {
      setWorking(false)
    }
  }
  if (props.start) void look(props.start)

  const selectable = (item: Candidate) => item.format.status !== "incompatible"
  const blocked = () =>
    [...chosen()].some((key) => {
      const item = preview()?.items.find((candidate) => candidate.key === key)
      if (!item?.conflict) return false
      if (item.conflict.replaceable && replace()) return false
      return !validSkillID(renames().get(key) ?? "")
    })

  async function install() {
    const current = preview()
    if (!current || chosen().size === 0 || !agreed() || blocked()) return
    setWorking(true)
    setError(undefined)
    try {
      const keys = [...chosen()]
      const renamed = keys.flatMap((key) => {
        const item = current.items.find((candidate) => candidate.key === key)
        const id = renames().get(key)
        if (!item?.conflict || id === undefined || (item.conflict.replaceable && replace())) return []
        return [{ key, id }]
      })
      // Every copy, a replacing one too, gets the chosen place first (SG-20).
      const skillsDir = props.skillsDir()
      const ids = keys.flatMap((key) => {
        const item = current.items.find((candidate) => candidate.key === key)
        return item ? [renamed.find((entry) => entry.key === key)?.id ?? item.id] : []
      })
      const placed =
        !props.scopes() || !skillsDir
          ? undefined
          : await place(
              props.runtime,
              ids.map((id) => copyFolder(skillsDir, id)),
              props.placeIn() ?? null,
            )
      const done = await rpc
        .call("skills.install", {
          nonce: current.nonce,
          keys,
          ...(renamed.length ? { renames: renamed } : {}),
          ...(replace() ? { replace: true } : {}),
        })
        .catch(async (failure: unknown) => {
          await unplace(props.runtime, placed)
          throw failure
        })
      showToast({
        message: placed?.directory
          ? text("own.skills.import.installedHere", { n: done.installed.length, project: baseName(placed.directory) })
          : text("own.skills.import.installed", { n: done.installed.length }),
      })
      props.onInstalled()
    } catch (failure) {
      setError(previewError(failure))
    } finally {
      setWorking(false)
    }
  }

  return (
    <div class="own-sk-imp-url" data-testid="skills-import-url-box">
      <form
        class="own-sk-imp-field"
        onSubmit={(event) => {
          event.preventDefault()
          if (url().trim()) void look({ url: url().trim() })
        }}
      >
        <span>{text("own.skills.import.urlLabel")}</span>
        <span class="own-sk-actions">
          <input
            class="own-sk-search own-sk-imp-grow"
            type="url"
            inputmode="url"
            value={url()}
            placeholder="https://github.com/owner/repo"
            spellcheck={false}
            autocomplete="off"
            data-testid="skills-import-url-input"
            onInput={(event) => setUrl(event.currentTarget.value)}
            onKeyDown={(event) => {
              // The Enter that commits an IME composition only commits (03 §12).
              if (event.key === "Enter" && event.isComposing) event.preventDefault()
            }}
          />
          <button type="submit" class="own-sk-btn" disabled={working() || !url().trim()} data-testid="skills-preview">
            {text("own.skills.import.preview")}
          </button>
        </span>
        <span class="own-sk-imp-note">{text("own.skills.import.urlHint")}</span>
      </form>
      <Show when={working() && !preview()}>
        <p class="own-sk-state">{text("own.skills.import.previewing")}</p>
      </Show>
      <Show when={error()}>
        {(key) => (
          <p class="own-sk-state" data-tone="danger" data-testid="skills-import-url-error">
            {text(key())}
          </p>
        )}
      </Show>
      <Show when={preview()}>
        {(current) => (
          <div class="own-sk-imp-preview" data-testid="skills-import-preview">
            <p class="own-sk-imp-note">
              {text(`own.skills.import.layout.${current().layout}`)} ·{" "}
              {text("own.skills.import.commit", { sha: shortCommit(current().commit) })} ·{" "}
              <code title={current().url}>{current().url}</code>
            </p>
            <Show
              when={current().items.length}
              fallback={<p class="own-sk-state">{text("own.skills.import.noSkills")}</p>}
            >
              <ul class="own-sk-imp-list">
                <For each={current().items}>
                  {(item) => (
                    <li class="own-sk-imp-row" data-skill={item.id} data-testid="skills-preview-row">
                      <label class="own-sk-imp-check">
                        <input
                          type="checkbox"
                          disabled={!selectable(item)}
                          checked={chosen().has(item.key)}
                          onChange={(event) => {
                            const on = event.currentTarget.checked
                            setChosen((set) => {
                              const next = new Set(set)
                              if (on) next.add(item.key)
                              else next.delete(item.key)
                              return next
                            })
                          }}
                        />
                        <span class="own-sk-name">{item.name}</span>
                        <code class="own-sk-id">@{item.id}</code>
                        <Show when={item.plugin}>
                          {(plugin) => (
                            <span class="own-sk-tag">{text("own.skills.import.plugin", { name: plugin() })}</span>
                          )}
                        </Show>
                        <Show when={item.scripts.length}>
                          <span class="own-sk-tag" data-tone="warn" title={item.scripts.join("\n")}>
                            {text("own.skills.import.scripts", { n: item.scripts.length })}
                          </span>
                        </Show>
                      </label>
                      <Show when={item.description}>
                        <span class="own-sk-desc">{item.description}</span>
                      </Show>
                      <details class="own-sk-imp-files">
                        <summary>
                          {text("own.skills.import.files", { n: item.fileCount })} · <code>{item.folder || "/"}</code>
                        </summary>
                        <code class="own-sk-imp-path">{item.files.join("\n")}</code>
                      </details>
                      <FormatLines format={item.format} />
                      <Show when={item.conflict && chosen().has(item.key) && !(item.conflict.replaceable && replace())}>
                        <label class="own-sk-imp-field">
                          <span>
                            {text(
                              item.conflict?.replaceable
                                ? "own.skills.import.conflictReplace"
                                : "own.skills.import.conflict",
                              { id: item.id },
                            )}
                          </span>
                          <input
                            class="own-sk-search"
                            type="text"
                            value={renames().get(item.key) ?? suggestID(item.id, "git", props.taken())}
                            spellcheck={false}
                            autocomplete="off"
                            onInput={(event) => {
                              const value = event.currentTarget.value.trim()
                              setRenames((map) => new Map([...map, [item.key, value]]))
                            }}
                          />
                        </label>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={current().external.length}>
              <p class="own-sk-imp-note">{text("own.skills.import.external")}</p>
              <ul class="own-sk-imp-list">
                <For each={current().external}>
                  {(entry) => (
                    <li class="own-sk-imp-row">
                      <span class="own-sk-line">
                        <span class="own-sk-name">{entry.plugin}</span>
                        <Show when={entry.repo}>
                          {(external) => (
                            <button
                              type="button"
                              class="own-sk-link"
                              onClick={() => {
                                setUrl(external().url)
                                void look(external())
                              }}
                            >
                              {text("own.skills.import.externalView")}
                            </button>
                          )}
                        </Show>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={current().items.some((item) => item.conflict?.replaceable)}>
              <label class="own-sk-imp-check">
                <input
                  type="checkbox"
                  checked={replace()}
                  onChange={(event) => setReplace(event.currentTarget.checked)}
                />
                {text("own.skills.import.replaceAll")}
              </label>
            </Show>
            <Show when={current().items.length}>
              <p class="own-sk-imp-warn">{text("own.skills.import.trust")}</p>
              <label class="own-sk-imp-check">
                <input
                  type="checkbox"
                  checked={agreed()}
                  data-testid="skills-install-trust"
                  onChange={(event) => setAgreed(event.currentTarget.checked)}
                />
                {text("own.skills.import.trustConfirm")}
              </label>
              <span class="own-sk-actions">
                <button
                  type="button"
                  class="own-sk-btn"
                  data-primary
                  data-testid="skills-install"
                  disabled={working() || chosen().size === 0 || !agreed() || blocked()}
                  onClick={() => void install()}
                >
                  {text("own.skills.import.install")}
                </button>
              </span>
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}

/** The repository a git import came from, to preview its newer version (`새 버전 보기`). */
function recordRepo(record: SkillRecord): Repo {
  return {
    url: record.url ?? "",
    ...(record.ref ? { ref: record.ref } : {}),
    ...(record.folder ? { folder: record.folder } : {}),
  }
}

const FETCH: ReadonlySet<string> = new Set([
  "git_missing",
  "unreachable",
  "not_found",
  "no_partial_clone",
  "timeout",
  "too_large",
  "other",
])

/** The message of a failed preview or install. */
function previewError(failure: unknown): SkillsImportKey {
  if (!(failure instanceof OwnRpcError)) return "own.skills.import.error.other"
  if (failure.type === "url_invalid") return "own.skills.import.error.url_invalid"
  if (failure.type === "nonce_invalid") return "own.skills.import.error.nonce"
  if (failure.type === "skills_unconfigured") return "own.skills.import.unconfigured"
  const reason = (failure.data as { readonly reason?: string } | undefined)?.reason
  if (failure.type === "fetch_failed" && reason !== undefined && FETCH.has(reason))
    return `own.skills.import.error.${reason}` as SkillsImportKey
  return "own.skills.import.error.other"
}
