// 설정 > 스킬 (03 §5.7, §19.6.1; SM 2026-10-24, global first SG 2026-10-26), a lazy settings chunk. Skills are global
// first: `모든 프로젝트` lists the catalog (own.accounts `skillset.view`: every skill a project gets before switches, no
// project needed) in groups by where it comes from, with search, the global switch, the projects that differ (a click
// picks one), `쓰는 곳` (`이 프로젝트만` keeps a skill's folder in one project), `상세 보기` (SK2: ./detail), `폴더
// 열기` (desktop) and `지우기…` for own-import's copies (own.import `skills.remove`, `local`). `프로젝트별 설정` works on
// one project (the picker): its exceptions (`되돌리기`), its own folder's skills and the ones kept for it, every
// project's skills with this project's switches, the ones only other projects use, and switches of skills that are
// gone. Every change is one `skillset.switch` (admin) with `되돌리기` in its toast; the page reads the view again on
// `skillset.changed` and when the project's skills change. `다른 도구에서 가져오기`: the composer popover's import view
// itself (`./import`), on this PC's service only (an SSH host runs no own.import).
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  lazy,
  onCleanup,
  Show,
  Suspense,
  type JSX,
} from "solid-js"
import type { OwnSkillset } from "@own/protocol"
import { useData, type ServerRuntime } from "@/data"
import { useHost } from "@/host"
import { Dialog, Tag, TextField } from "@/limits/kit"
import { createProjectChoice, ProjectPicker } from "@/projects/choice"
import { baseName, samePath } from "@/projects/path"
import { takeSettingsIntent } from "@/settings/intent"
import { showToast } from "@/switcher/toast"
import { isInside } from "@/worktree/model"
import type { DetailPlace, DetailRequest } from "./detail"
import { reloadSkills } from "./actions"
import { sourceOf, type ClaudeAccount } from "./import-model"
import { useSkillsImportText } from "./import-strings"
import { filterSkills } from "./model"
import {
  chosenScope,
  builtIn,
  globalSection,
  grouped,
  projectNames,
  projectSection,
  scopable,
  scopeChoices,
  scopeOf,
  type ProjectSkill,
  type SkillGroup,
  type SkillRow,
} from "./settings-model"
import { useSkillSettingsText, type SkillSettingsKey } from "./settings-strings"
import type { SkillsKey } from "./strings"
import "./skills.css"

const Import = lazy(() => import("./import"))
const SkillDetail = lazy(() => import("./detail"))

/** The page's group names: the popover's source words where they are the same (SK2), the page's own otherwise. */
const GROUP_TEXT: Readonly<Record<SkillGroup, SkillSettingsKey | SkillsKey>> = {
  project: "own.skills.source.project",
  imported: "own.skillset.group.imported",
  global: "own.skills.source.global",
  claude: "own.skillset.group.claude",
  own: "own.skillset.group.own",
  builtin: "own.skills.source.builtin",
}

export interface SkillsSettingsProps {
  /** The project to start on (the session or project on screen). */
  readonly directory?: string
}

export default function SkillsSettings(props: SkillsSettingsProps) {
  const data = useData()
  const host = useHost()
  const text = useSkillSettingsText()
  const runtime = () => data.local()
  const choice = createProjectChoice({ runtime, directory: () => props.directory })
  const directory = choice.directory
  const location = () => {
    const where = directory()
    return where ? { directory: where } : undefined
  }
  const [loading] = createResource(location, (ref) => runtime().data.location.skill.sync(ref))
  const skills = () => {
    const ref = location()
    return ref ? runtime().data.location.skill.list(ref) : undefined
  }
  const readable = () => runtime().imports.allowed("skills.list")
  const removable = () => runtime().imports.allowed("skills.remove")
  // own.accounts keeps the switches on this PC's service only; an SSH host loads its own folders' skills.
  const viewable = () => runtime().kind !== "ssh" && runtime().rpc.allowed("skillset.view")
  const switchable = () => viewable() && runtime().rpc.allowed("skillset.switch")
  const ids = () => (skills() ?? []).map((skill) => skill.id).join("\n")
  // own's skills folder and own-import's copies; read again when the skills core loads change (an import, a removal).
  const [copies, { refetch }] = createResource(
    // Never an empty string (a falsy source would not fetch): a project with no skills reads the copies too.
    () => (readable() ? `skills:${ids()}` : undefined),
    () => runtime().imports.call("skills.list", {}),
  )
  // The switches and scopes: read again on `skillset.changed` and when the project's skills change (a fold took one
  // away or gave one back, a skill was imported or removed).
  const [view, { refetch: refetchView }] = createResource(
    () => (viewable() ? { directory: directory(), ids: ids() } : undefined),
    (source) => runtime().rpc.call("skillset.view", source.directory ? { directory: source.directory } : {}),
  )
  // A switch folds the projects' skills again; core's announcement of that names no Location, so read the chosen
  // project's list here (its ids changing reads the view again too).
  const reread = () => {
    const where = directory()
    if (where) void reloadSkills(runtime(), where)
    void refetchView()
  }
  onCleanup(runtime().own.on("skillset.changed", reread))
  const [query, setQuery] = createSignal("")
  const [removing, setRemoving] = createSignal<SkillRow>()
  const [showing, setShowing] = createSignal<SkillRow>()
  const [busy, setBusy] = createSignal(false)
  const [sending, setSending] = createSignal(false)
  /** Bumped after a removal: the import view reads the other tools' skills again (its `이 앱에 있음` marks). */
  const [generation, setGeneration] = createSignal(1)
  // own-import's copies only mark rows, so the page never waits for them, and an own-import that is not running (or
  // a failed read) leaves the rows unmarked: `latest` would suspend until the first answer and throw its error (MR13).
  const copied = () => (copies.state === "ready" || copies.state === "refreshing" ? copies.latest : undefined)
  const options = () => ({ skillsDir: copied()?.directory, imports: copied()?.imports ?? [] })
  // `latest` throws a resource's error: read it only when there is none.
  const current = () => (view.error ? undefined : view.latest)
  const everywhere = createMemo(() => {
    const read = current()
    return read ? globalSection(read, options()) : undefined
  })
  const shownGlobal = createMemo(() => {
    const rows = everywhere()?.rows ?? []
    const matched = new Set(
      filterSkills(
        rows.map((item) => item.row),
        query(),
      ).map((row) => row.path),
    )
    return grouped(rows.filter((item) => matched.has(item.row.path)).map((item) => item.row)).map((entry) => ({
      group: entry.group,
      items: entry.rows.map((row) => rows.find((item) => item.row.path === row.path)!),
    }))
  })
  const project = createMemo(() => {
    const read = current()
    const where = directory()
    const listed = skills()
    if (!read || !where || listed === undefined || read.off === undefined) return undefined
    return projectSection(read, { directory: where, listed, ...options() })
  })
  const projectName = () => {
    const where = directory()
    return where ? baseName(where) : ""
  }
  const opener = () => host.files?.openPath
  let importSection: HTMLElement | undefined

  // `스킬 가져오기…` from the palette, also while this page is already open: the intent is read in the effect (SK2).
  createEffect(() => {
    if (!readable() || takeSettingsIntent(["skills.import"]) === undefined) return
    requestAnimationFrame(() => importSection?.scrollIntoView({ block: "start" }))
  })

  /** One `skillset.switch`; its toast offers `되돌리기` (the records as they were at that place). */
  async function send(input: OwnSkillset.SwitchInput, message: string, undo?: OwnSkillset.SwitchInput) {
    if (sending()) return
    setSending(true)
    const done = await runtime()
      .rpc.call("skillset.switch", input)
      .then(
        () => true,
        (error: unknown) => {
          console.error("[own-web] skillset.switch", error)
          return false
        },
      )
    setSending(false)
    if (!done) return showToast({ tone: "danger", message: text("own.skillset.toast.failed") })
    reread()
    showToast({
      message,
      ...(undo
        ? {
            action: {
              label: text("own.skillset.revert"),
              run: () => void send(undo, text("own.skillset.toast.reverted")),
            },
          }
        : {}),
    })
  }

  const switches = () => current()?.switches ?? []
  /** The switch at exactly this place, as `되돌리기` puts it back (`null`: none). */
  const atPlace = (id: string, place: string | undefined) =>
    switches().find(
      (item) =>
        item.id === id &&
        (place === undefined
          ? item.directory === undefined
          : item.directory !== undefined && samePath(item.directory, place)),
    )?.enabled ?? null

  function setGlobal(row: SkillRow, enabled: boolean) {
    const before = atPlace(row.id, undefined)
    void send(
      { changes: [{ id: row.id, enabled }] },
      text(enabled ? "own.skillset.toast.onAll" : "own.skillset.toast.offAll", { name: row.name }),
      { changes: [{ id: row.id, enabled: before }] },
    )
  }

  function setHere(row: SkillRow, enabled: boolean | null) {
    const where = directory()
    if (!where) return
    const before = atPlace(row.id, where)
    const message =
      enabled === null
        ? text("own.skillset.toast.reverted")
        : text(enabled ? "own.skillset.toast.onHere" : "own.skillset.toast.offHere", { name: row.name })
    void send({ changes: [{ id: row.id, directory: where, enabled }] }, message, {
      changes: [{ id: row.id, directory: where, enabled: before }],
    })
  }

  /**
   * `쓰는 곳` of a row: the scope that keeps it now (a nested skill's may be its folder's above, which it goes with),
   * else its own folder, or its file for a flat skill (SG-19).
   */
  function setScope(row: SkillRow, target: string | null) {
    const scope = scopeOf(current()?.scopes ?? [], row.path)
    const folder = scope?.folder ?? row.scopePath
    void send(
      { changes: [], scopes: [{ folder, directory: target }] },
      target === null
        ? text("own.skillset.toast.scopeAll", { name: row.name })
        : text("own.skillset.toast.scopeHere", { name: row.name, project: baseName(target) }),
      { changes: [], scopes: [{ folder, directory: scope?.directory ?? null }] },
    )
  }

  /** A scope that holds no skill any more (SG-21): cleared, with `되돌리기`. */
  function clearScope(scope: OwnSkillset.Scope) {
    void send(
      { changes: [], scopes: [{ folder: scope.folder, directory: null }] },
      text("own.skillset.toast.orphanCleared"),
      { changes: [], scopes: [{ folder: scope.folder, directory: scope.directory }] },
    )
  }

  function clear(id: string, place: string | undefined) {
    void send(
      { changes: [{ id, ...(place === undefined ? {} : { directory: place }), enabled: null }] },
      text("own.skillset.toast.cleared", { id }),
    )
  }

  async function open(row: SkillRow) {
    const run = opener()
    if (!run) return
    await run(row.folder).catch(() => showToast({ tone: "danger", message: text("own.skillset.openFailed") }))
  }

  async function remove(row: SkillRow) {
    // The record's own id (a skill id the service gave), not the folder name the page matched.
    const id = copied()?.imports.find((item) => item.id === row.imported)?.id
    if (!id || busy()) return
    setBusy(true)
    const done = await runtime()
      .imports.call("skills.remove", { id })
      .then(
        () => true,
        (error: unknown) => {
          console.error("[own-web] skills.remove", error)
          return false
        },
      )
    setBusy(false)
    setRemoving(undefined)
    showToast(
      done
        ? { message: text("own.skillset.removed", { id }) }
        : { tone: "danger", message: text("own.skillset.removeFailed") },
    )
    if (!done) return
    // The folder is gone, and with it what its scopes said (its own and any inside it, SG-21).
    const stale = (current()?.scopes ?? []).filter((scope) => isInside(row.scopePath, scope.folder))
    if (switchable() && stale.length > 0)
      await runtime()
        .rpc.call("skillset.switch", {
          changes: [],
          scopes: stale.map((scope) => ({ folder: scope.folder, directory: null })),
        })
        .catch((error: unknown) => console.error("[own-web] skillset.switch", error))
    void refetch()
    void refetchView()
    setGeneration((value) => value + 1)
  }

  /** The row's own buttons: `상세 보기`, `폴더 열기`, `지우기…`. */
  const actions = (row: SkillRow) => (
    <>
      <button
        type="button"
        class="own-btn"
        data-size="sm"
        aria-haspopup="dialog"
        data-testid="settings-skills-detail"
        onClick={() => setShowing(row)}
      >
        {text("own.skillset.detail")}
      </button>
      <Show when={opener() && !builtIn(row.group)}>
        <button
          type="button"
          class="own-btn"
          data-size="sm"
          data-testid="settings-skills-open"
          onClick={() => void open(row)}
        >
          {text("own.skillset.open")}
        </button>
      </Show>
      <Show when={row.imported && removable()}>
        <button
          type="button"
          class="own-btn"
          data-size="sm"
          aria-haspopup="dialog"
          data-testid="settings-skills-remove"
          onClick={() => setRemoving(row)}
        >
          {text("own.skillset.remove")}
        </button>
      </Show>
    </>
  )

  /** `쓰는 곳`: every project, this project only, or the project its scope names. */
  const whereSelect = (row: SkillRow) => {
    const scope = () => scopeOf(current()?.scopes ?? [], row.path)
    const list = () => scopeChoices(scope(), directory())
    return (
      <Show when={switchable() && scopable(row)}>
        <label class="flex items-center gap-1.5 text-[12px] text-own-muted">
          <span>{text("own.skillset.where")}</span>
          {/* Options are numbered: a folder path stays out of the DOM's attributes (the manual's privacy check). */}
          <select
            class="own-input h-7 max-w-56 min-w-0 text-[12px]"
            data-testid="settings-skills-where"
            value={String(chosenScope(list(), scope()))}
            disabled={sending()}
            onChange={(event) => {
              const picked = list()[Number(event.currentTarget.value)]
              if (picked) setScope(row, picked.type === "all" ? null : picked.directory)
            }}
          >
            <For each={list()}>
              {(item, index) => (
                <option value={String(index())} selected={index() === chosenScope(list(), scope())}>
                  {item.type === "all"
                    ? text("own.skillset.where.all")
                    : item.type === "here"
                      ? text("own.skillset.where.here", { name: baseName(item.directory) })
                      : text("own.skillset.where.folder", { name: baseName(item.directory) })}
                </option>
              )}
            </For>
          </select>
        </label>
      </Show>
    )
  }

  /** `{projects}에서 꺼 둠` / `{projects}에서만 켬`: each name picks that project below. */
  const projectsLine = (directories: ReadonlyArray<string>, key: "own.skillset.offIn" | "own.skillset.onlyIn") => {
    const names = projectNames(directories)
    return (
      <span class="text-[12px] text-own-muted" data-testid="settings-skills-exceptions" data-kind={key}>
        {text(key, { projects: "\u0000" })
          .split("\u0000")
          .flatMap((part, index) =>
            index === 0
              ? [part]
              : [
                  <For each={names.shown}>
                    {(item, at) => (
                      <>
                        {at() > 0 ? ", " : ""}
                        <button
                          type="button"
                          class="own-sk-link"
                          title={item.directory}
                          onClick={() => choice.choose(item.directory)}
                        >
                          {item.name}
                        </button>
                      </>
                    )}
                  </For>,
                  names.more > 0 ? ` ${text("own.skillset.more", { n: names.more })}` : "",
                  part,
                ],
          )}
      </span>
    )
  }

  const emptyLine = (message: string, testid?: string) => (
    <p class="m-0 text-[12.5px] text-own-muted" data-testid={testid}>
      {message}
    </p>
  )

  return (
    <div class="flex flex-col gap-4" data-testid="settings-skills">
      <p class="m-0 text-[13px] leading-5 text-own-muted">{text("own.skillset.lead")}</p>
      <Show when={!switchable()}>
        <p class="m-0 text-[12.5px] text-own-muted" data-testid="settings-skills-no-switches">
          {text("own.skillset.noSwitches")}
        </p>
      </Show>
      <section class="flex flex-col gap-2" data-testid="settings-skills-all">
        <div>
          <b class="block text-[13.5px] font-semibold">{text("own.skillset.all")}</b>
          <span class="text-[12px] text-own-muted">{text("own.skillset.allNote")}</span>
        </div>
        <TextField
          label={text("own.skills.search")}
          hideLabel
          placeholder={text("own.skills.search")}
          value={query()}
          onValue={setQuery}
          spellcheck={false}
          autocomplete="off"
          testid="settings-skills-search"
        />
        <Show when={switchable()}>
          <p class="m-0 text-[12px] text-own-faint" data-testid="settings-skills-cache">
            {text("own.skillset.cacheNote")}
          </p>
        </Show>
        <Show
          when={everywhere()}
          fallback={
            <Show
              when={view.error}
              fallback={emptyLine(viewable() ? text("own.skills.loading") : text("own.skillset.noSwitches"))}
            >
              <p class="m-0 text-[12.5px] text-own-danger">
                {text("own.skillset.viewFailed")}{" "}
                <button type="button" class="own-sk-link" onClick={() => void refetchView()}>
                  {text("own.skills.retry")}
                </button>
              </p>
            </Show>
          }
        >
          {(section) => (
            <>
              <Show
                when={shownGlobal().length > 0}
                fallback={emptyLine(
                  section().rows.length > 0 ? text("own.skills.noMatch") : text("own.skillset.allEmpty"),
                  "settings-skills-empty",
                )}
              >
                <For each={shownGlobal()}>
                  {(entry) => (
                    <div class="flex flex-col gap-1" data-testid="settings-skills-group" data-group={entry.group}>
                      <span class="text-[12px] font-semibold text-own-muted">
                        {text("own.skillset.count", { group: text(GROUP_TEXT[entry.group]), n: entry.items.length })}
                      </span>
                      <ul class="m-0 flex list-none flex-col divide-y divide-own-border rounded-lg border border-own-border p-0">
                        <For each={entry.items}>
                          {(item) => (
                            <SkillLine
                              row={item.row}
                              section="all"
                              tags={
                                <Show when={item.off}>
                                  <Tag tone="warn" testid="settings-skills-off-all">
                                    {text("own.skillset.offAll")}
                                  </Tag>
                                </Show>
                              }
                              toggle={
                                <Show when={switchable()}>
                                  <Toggle
                                    on={!item.off}
                                    label={text("own.skillset.switchAll", { name: item.row.name })}
                                    busy={sending()}
                                    testid="settings-skills-toggle-all"
                                    onChange={(on) => setGlobal(item.row, on)}
                                  />
                                </Show>
                              }
                              actions={actions(item.row)}
                              extra={
                                <>
                                  <Show when={item.exceptions.off.length > 0}>
                                    {projectsLine(item.exceptions.off, "own.skillset.offIn")}
                                  </Show>
                                  <Show when={item.exceptions.only.length > 0}>
                                    {projectsLine(item.exceptions.only, "own.skillset.onlyIn")}
                                  </Show>
                                  {whereSelect(item.row)}
                                </>
                              }
                            />
                          )}
                        </For>
                      </ul>
                    </div>
                  )}
                </For>
              </Show>
              <GoneRows ids={section().gone} switchable={switchable()} onClear={(id) => clear(id, undefined)} />
              <OrphanScopes
                scopes={section().orphans}
                switchable={switchable()}
                busy={sending()}
                onClear={clearScope}
              />
            </>
          )}
        </Show>
      </section>
      <section class="flex flex-col gap-2 border-t border-own-border pt-3" data-testid="settings-skills-project">
        <div>
          <b class="block text-[13.5px] font-semibold">{text("own.skillset.perProject")}</b>
          <span class="text-[12px] text-own-muted">{text("own.skillset.perProjectNote")}</span>
        </div>
        <ProjectPicker choice={choice} label={text("own.skillset.project")} testid="skills-project" />
        <Show when={location()} fallback={emptyLine(text("own.skillset.pickProject"), "settings-skills-pick")}>
          <Show
            when={project()}
            fallback={
              <Show
                when={loading.error}
                fallback={emptyLine(viewable() ? text("own.skills.loading") : text("own.skillset.noSwitches"))}
              >
                <p class="m-0 text-[12.5px] text-own-danger">
                  {text("own.skills.failed")}{" "}
                  <button
                    type="button"
                    class="own-sk-link"
                    onClick={() => {
                      const ref = location()
                      if (ref)
                        void runtime()
                          .data.location.skill.sync(ref)
                          .catch(() => undefined)
                    }}
                  >
                    {text("own.skills.retry")}
                  </button>
                </p>
              </Show>
            }
          >
            {(here) => (
              <div class="flex flex-col gap-3">
                <ProjectGroup
                  title={text("own.skillset.exceptions", { n: here().exceptions.length })}
                  testid="settings-skills-exceptions-group"
                  open
                >
                  <Show when={here().exceptions.length > 0} fallback={emptyLine(text("own.skillset.exceptionsNone"))}>
                    <ul class="m-0 flex list-none flex-col divide-y divide-own-border rounded-lg border border-own-border p-0">
                      <For each={here().exceptions}>
                        {(item) => (
                          <SkillLine
                            row={item.row}
                            section="exception"
                            tags={
                              <Tag tone={item.enabled ? "ok" : "warn"} testid="settings-skills-exception-tag">
                                {text(item.enabled ? "own.skillset.tag.onlyHere" : "own.skillset.tag.offHere")}
                              </Tag>
                            }
                            toggle={
                              <Show when={switchable()}>
                                <button
                                  type="button"
                                  class="own-btn"
                                  data-size="sm"
                                  disabled={sending()}
                                  data-testid="settings-skills-revert"
                                  onClick={() => setHere(item.row, null)}
                                >
                                  {text("own.skillset.revert")}
                                </button>
                              </Show>
                            }
                          />
                        )}
                      </For>
                    </ul>
                  </Show>
                </ProjectGroup>
                <ProjectGroup
                  title={text("own.skillset.ownGroup", { n: here().own.length })}
                  testid="settings-skills-own-group"
                  open
                >
                  <Show when={here().own.length > 0} fallback={emptyLine(text("own.skillset.empty"))}>
                    <ProjectRows
                      items={here().own}
                      switchable={switchable()}
                      busy={sending()}
                      project={projectName()}
                      directory={directory()}
                      onSwitch={(item, on) => setHere(item.row, on)}
                      actions={actions}
                      where={whereSelect}
                    />
                  </Show>
                </ProjectGroup>
                <ProjectGroup
                  title={text("own.skillset.allGroup", { n: here().all.length })}
                  testid="settings-skills-everyone-group"
                >
                  <ProjectRows
                    items={here().all}
                    switchable={switchable()}
                    busy={sending()}
                    project={projectName()}
                    directory={directory()}
                    onSwitch={(item, on) => setHere(item.row, on)}
                    actions={actions}
                    where={whereSelect}
                  />
                </ProjectGroup>
                <Show when={here().elsewhere.length > 0}>
                  <ProjectGroup
                    title={text("own.skillset.elsewhereGroup", { n: here().elsewhere.length })}
                    testid="settings-skills-elsewhere-group"
                  >
                    <ul class="m-0 flex list-none flex-col divide-y divide-own-border rounded-lg border border-own-border p-0">
                      <For each={here().elsewhere}>
                        {(item) => (
                          <SkillLine
                            row={item.row}
                            section="elsewhere"
                            tags={
                              <Tag tone="soft">
                                {text("own.skillset.tag.folder", { name: baseName(item.scope.directory) })}
                              </Tag>
                            }
                            actions={actions(item.row)}
                            extra={whereSelect(item.row)}
                          />
                        )}
                      </For>
                    </ul>
                  </ProjectGroup>
                </Show>
                <GoneRows ids={here().gone} switchable={switchable()} onClear={(id) => clear(id, directory())} />
              </div>
            )}
          </Show>
        </Show>
      </section>
      <section
        ref={importSection}
        class="flex flex-col gap-2 border-t border-own-border pt-3"
        data-testid="settings-skills-import"
      >
        <div>
          <b class="block text-[13.5px] font-semibold">{text("own.skillset.import")}</b>
          <span class="text-[12px] text-own-muted">{text("own.skillset.importNote")}</span>
        </div>
        <Show when={readable()} fallback={emptyLine(text("own.skillset.importUnavailable"))}>
          <div>
            <Suspense fallback={emptyLine(text("own.skills.loading"))}>
              <Show when={generation()} keyed>
                {(_generation: number) => (
                  <Import
                    runtime={runtime()}
                    embedded
                    // Not known while core has not answered for the project (SK2 2026-10-25: the rows wait).
                    loaded={() =>
                      location() !== undefined && skills() === undefined
                        ? undefined
                        : (skills() ?? []).map((skill) => ({ id: skill.id, path: skill.path }))
                    }
                    directory={directory}
                    onChanged={() => void refetchView()}
                  />
                )}
              </Show>
            </Suspense>
          </div>
        </Show>
      </section>
      <Dialog
        open={showing() !== undefined}
        title={text("own.skillset.detailTitle", { name: showing()?.name ?? "" })}
        size="wide"
        dismissable
        onClose={() => setShowing(undefined)}
        testid="settings-skills-detail-dialog"
        footer={
          <button type="button" class="own-btn" data-size="sm" onClick={() => setShowing(undefined)}>
            {text("own.skillset.close")}
          </button>
        }
      >
        <Show when={showing()} keyed>
          {(row) => (
            <Suspense fallback={emptyLine(text("own.skills.loading"))}>
              <RowDetail
                runtime={runtime()}
                row={row}
                body={(skills() ?? []).find((skill) => skill.path === row.path)?.content ?? ""}
                directory={directory()}
                readable={readable()}
                here={text("own.skillset.here")}
                group={text(GROUP_TEXT[row.group])}
                links={(copied()?.imports ?? []).flatMap((item) =>
                  (item.links ?? []).flatMap((link) => (link.linkKey ? [link.linkKey] : [])),
                )}
              />
            </Suspense>
          )}
        </Show>
      </Dialog>
      <Dialog
        open={removing() !== undefined}
        title={text("own.skillset.removeTitle")}
        onClose={() => setRemoving(undefined)}
        testid="settings-skills-remove-dialog"
        footer={
          <>
            <button type="button" class="own-btn" data-size="sm" onClick={() => setRemoving(undefined)}>
              {text("own.skillset.cancel")}
            </button>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              data-variant="danger"
              disabled={busy()}
              data-testid="settings-skills-remove-confirm"
              onClick={() => {
                const row = removing()
                if (row) void remove(row)
              }}
            >
              {text("own.skillset.removeYes")}
            </button>
          </>
        }
      >
        <p class="m-0">{text("own.skillset.removeConfirm", { id: removing()?.imported ?? "" })}</p>
      </Dialog>
    </div>
  )
}

/** One skill's row: name, `@id`, tags and the switch on one line, then its buttons, description and folder. */
function SkillLine(props: {
  readonly row: SkillRow
  readonly section: "all" | "exception" | "own" | "everyone" | "elsewhere"
  readonly tags?: JSX.Element
  readonly toggle?: JSX.Element
  readonly actions?: JSX.Element
  readonly extra?: JSX.Element
}) {
  const text = useSkillSettingsText()
  return (
    <li
      class="flex flex-col gap-1 px-3 py-2.5"
      data-testid="settings-skills-row"
      data-skill={props.row.id}
      data-group={props.row.group}
      data-section={props.section}
    >
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-[13px] font-semibold">{props.row.name}</span>
        <code class="own-mono text-[12px] text-own-muted">@{props.row.id}</code>
        <Show when={props.row.auto}>
          <Tag tone="soft" title={text("own.skills.autoHint")}>
            {text("own.skills.auto")}
          </Tag>
        </Show>
        {props.tags}
        <span class="flex-1" />
        {props.toggle}
      </div>
      <Show when={props.actions}>
        <div class="flex flex-wrap items-center gap-2">{props.actions}</div>
      </Show>
      <Show when={props.row.description}>
        <span class="text-[12.5px] text-own-muted">{props.row.description}</span>
      </Show>
      <Show when={!builtIn(props.row.group)}>
        <span class="own-mono truncate text-[11.5px] text-own-faint" title={props.row.path}>
          {props.row.folder}
        </span>
      </Show>
      <Show when={props.extra}>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">{props.extra}</div>
      </Show>
    </li>
  )
}

/** The rows of one project with this project's switch: on there or off (and why). */
function ProjectRows(props: {
  readonly items: ReadonlyArray<ProjectSkill>
  readonly switchable: boolean
  readonly busy: boolean
  readonly project: string
  readonly directory: string | undefined
  readonly onSwitch: (item: ProjectSkill, on: boolean) => void
  readonly actions: (row: SkillRow) => JSX.Element
  readonly where: (row: SkillRow) => JSX.Element
}) {
  const text = useSkillSettingsText()
  return (
    <ul class="m-0 flex list-none flex-col divide-y divide-own-border rounded-lg border border-own-border p-0">
      <For each={props.items}>
        {(item) => (
          <SkillLine
            row={item.row}
            section={item.scope || item.row.group === "project" ? "own" : "everyone"}
            tags={
              <>
                <Show when={item.scope}>
                  {(scope) => (
                    <Tag tone="soft" testid="settings-skills-scope-tag">
                      {props.directory && samePath(scope().directory, props.directory)
                        ? text("own.skillset.tag.here")
                        : text("own.skillset.tag.folder", { name: baseName(scope().directory) })}
                    </Tag>
                  )}
                </Show>
                <Show when={item.by === "global"}>
                  <Tag tone="warn">{text("own.skillset.offAll")}</Tag>
                </Show>
                <Show when={item.by === "scope"}>
                  <Tag tone="plain">{text("own.skillset.tag.scope")}</Tag>
                </Show>
              </>
            }
            toggle={
              <Show when={props.switchable && item.by !== "scope"}>
                <Toggle
                  on={item.on}
                  label={text("own.skillset.switchHere", { name: item.row.name })}
                  busy={props.busy}
                  testid="settings-skills-toggle-here"
                  onChange={(on) => props.onSwitch(item, on)}
                />
              </Show>
            }
            actions={props.actions(item.row)}
            extra={item.scope ? props.where(item.row) : undefined}
          />
        )}
      </For>
    </ul>
  )
}

/** A folded group of the project section (`<details>`: the exceptions and the project's skills start open). */
function ProjectGroup(props: {
  readonly title: string
  readonly testid: string
  readonly open?: boolean
  readonly children: JSX.Element
}) {
  return (
    <details class="flex flex-col gap-1" open={props.open} data-testid={props.testid}>
      <summary class="cursor-pointer text-[12px] font-semibold text-own-muted select-none">{props.title}</summary>
      <div class="mt-1">{props.children}</div>
    </details>
  )
}

/** Switches of skill ids no skill has (any more): `지금은 없는 스킬이에요` and `설정 지우기`. */
function GoneRows(props: {
  readonly ids: ReadonlyArray<string>
  readonly switchable: boolean
  readonly onClear: (id: string) => void
}) {
  const text = useSkillSettingsText()
  return (
    <Show when={props.ids.length > 0}>
      <ul class="m-0 flex list-none flex-col divide-y divide-own-border rounded-lg border border-own-border p-0">
        <For each={props.ids}>
          {(id) => (
            <li class="flex flex-wrap items-center gap-2 px-3 py-2" data-testid="settings-skills-gone" data-skill={id}>
              <code class="own-mono text-[12px]">@{id}</code>
              <span class="text-[12px] text-own-muted">{text("own.skillset.gone")}</span>
              <span class="flex-1" />
              <Show when={props.switchable}>
                <button
                  type="button"
                  class="own-btn"
                  data-size="sm"
                  data-testid="settings-skills-clear"
                  onClick={() => props.onClear(id)}
                >
                  {text("own.skillset.clear")}
                </button>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

/**
 * Scopes whose folder holds no skill any more (SG-21: deleted by hand, or moved): the folder, the project it named and
 * `설정 지우기`, so a later copy of that name is not kept there by a stale record.
 */
function OrphanScopes(props: {
  readonly scopes: ReadonlyArray<OwnSkillset.Scope>
  readonly switchable: boolean
  readonly busy: boolean
  readonly onClear: (scope: OwnSkillset.Scope) => void
}) {
  const text = useSkillSettingsText()
  return (
    <Show when={props.scopes.length > 0}>
      <ul
        class="m-0 flex list-none flex-col divide-y divide-own-border rounded-lg border border-own-border p-0"
        data-testid="settings-skills-orphans"
      >
        <For each={props.scopes}>
          {(scope) => (
            <li class="flex flex-col gap-1 px-3 py-2" data-testid="settings-skills-orphan">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-[12.5px] text-own-muted">{text("own.skillset.orphan")}</span>
                <Tag tone="soft">{text("own.skillset.tag.folder", { name: baseName(scope.directory) })}</Tag>
                <span class="flex-1" />
                <Show when={props.switchable}>
                  <button
                    type="button"
                    class="own-btn"
                    data-size="sm"
                    disabled={props.busy}
                    data-testid="settings-skills-orphan-clear"
                    onClick={() => props.onClear(scope)}
                  >
                    {text("own.skillset.clear")}
                  </button>
                </Show>
              </div>
              <span class="own-mono truncate text-[11.5px] text-own-faint" title={scope.folder}>
                {scope.folder}
              </span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

/** The page's switch, like the MCP list's (aria-disabled keeps the focus while a change is out). */
function Toggle(props: {
  readonly on: boolean
  readonly label: string
  readonly busy: boolean
  readonly testid: string
  readonly onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      aria-disabled={props.busy}
      class="group own-target relative inline-flex h-5 w-9 flex-none items-center rounded-full border border-own-border-input bg-own-subtle transition-colors aria-checked:border-own-accent aria-checked:bg-own-accent aria-disabled:opacity-50"
      data-testid={props.testid}
      onClick={() => {
        if (!props.busy) props.onChange(!props.on)
      }}
    >
      <span
        aria-hidden="true"
        class="inline-block h-3.5 w-3.5 translate-x-0.5 rounded-full bg-own-muted transition-transform group-aria-checked:translate-x-[18px] group-aria-checked:bg-own-on-accent"
      />
    </button>
  )
}

/**
 * `상세 보기` of a skill (SK2): own-import's copy by its id, a built-in one from core's own text, any other by the
 * folder core reports for this project. Its places: where this project reads it, then the other tools' copies of the
 * same folder or the same content (a list with every hash, read when the dialog opens).
 */
function RowDetail(props: {
  readonly runtime: ServerRuntime
  readonly row: SkillRow
  /** The body core holds (a built-in skill has no folder to read). */
  readonly body: string
  readonly directory: string | undefined
  readonly readable: boolean
  readonly here: string
  readonly group: string
  /** The approved links of own-import's copies (their records). */
  readonly links: ReadonlyArray<string>
}) {
  const imports = useSkillsImportText()
  // Every hash, and the links own-import's copies were made through, so a copy's source is found by its content too.
  const [found] = createResource(
    () => (props.readable && !builtIn(props.row.group) ? true : undefined),
    () =>
      props.runtime.imports.call("skills.list", {
        hashes: true,
        ...(props.links.length ? { approvedLinks: [...props.links] } : {}),
      }),
  )
  const accounts = createMemo((): ClaudeAccount[] =>
    Object.values(props.runtime.own.state.accounts).flatMap((account) =>
      account?.kind === "claude-sub" && account.claude?.accountUuid
        ? [{ label: account.label, uuid: account.claude.accountUuid }]
        : [],
    ),
  )
  const request = (): DetailRequest => {
    if (props.row.imported) return { kind: "copy", id: props.row.imported }
    if (builtIn(props.row.group) || !props.directory)
      return {
        kind: "builtin",
        name: props.row.name,
        ...(props.row.description ? { description: props.row.description } : {}),
        body: props.body,
        path: props.row.path,
      }
    return { kind: "loaded", directory: props.directory, id: props.row.id }
  }
  const places = (detail: { readonly hash?: string } | undefined): DetailPlace[] => {
    const listing = found.latest
    const folder = key(props.row.folder)
    const others = (listing?.items ?? []).filter(
      (item) =>
        key(item.real ?? item.directory) === folder ||
        key(item.directory) === folder ||
        (detail?.hash !== undefined && item.hash === detail.hash),
    )
    return [
      { label: `${props.here} · ${props.group}`, path: props.row.folder, main: true },
      ...others
        .filter((item) => key(item.directory) !== folder)
        .map((item) => {
          const source = sourceOf(item, listing?.roots ?? [], accounts())
          return {
            label: imports(source.label.key, source.label.params),
            path: item.directory,
            ...(item.modifiedAt ? { modifiedAt: item.modifiedAt } : {}),
            ...(item.version ? { version: item.version } : {}),
          }
        }),
    ]
  }
  return <SkillDetail runtime={props.runtime} request={request()} places={places} />
}

function key(path: string) {
  const slashed = path.replaceAll("\\", "/").replace(/\/+$/, "")
  return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed
}
