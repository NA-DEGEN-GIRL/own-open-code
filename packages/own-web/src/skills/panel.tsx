// Skills popover (03 §19.6), a lazy chunk opened from the composer's `✦ 스킬` button or `openSkills()`: the folder's
// skills (project first), a search box (IME-safe, 03 §12), and for the highlighted skill `칩으로 추가` (Enter: the
// skill goes with the next message as `skills[]`) or `바로 실행` (Ctrl+Enter: `session.skill`, appended at the end of
// the history and the agent starts). Like the palette search, the Enter that commits a Korean composition only
// commits; the next Enter applies (rule 8 exception, `바로 실행` wakes the agent). The `가져오기` tab (03 §19.6.1) swaps
// the list for the skills of other tools on this PC and `URL로 설치…` (its own lazy chunk, ./import), on servers that run
// own.import (this PC's service, not an SSH host). SK2: `설정에서 스킬 관리` beside the tabs opens 설정 > 스킬.
// SG (2026-10-26): on this PC's service each row has `끄기` (a switch of own.accounts for the popover's folder), and a
// folded group lists the skills switched off there (`skillset.view{directory}`) with `켜기`, or `설정에서 보기` for one
// a scope keeps in another project; each change's toast offers `되돌리기`. No new key binding.
import { createMemo, createResource, createSignal, For, lazy, onCleanup, onMount, Show, Suspense } from "solid-js"
import type { OwnSkillset } from "@own/protocol"
import { fitMenu } from "@/composer/fit"
import type { ServerRuntime } from "@/data"
import { createImeEnter, isImeKey } from "@/ime/ime-enter"
import { eventCode } from "@/keyboard/chord"
import type { MentionChip } from "@/mentions"
import { useRouter } from "@/routing/router"
import { showToast } from "@/switcher/toast"
import { loadSkills, reloadSkills, runSkill } from "./actions"
import { filterSkills, runBlock, skillViews, VISIBLE_SKILLS, type SkillView } from "./model"
import { useSkillsImportText, type SkillsImportKey } from "./import-strings"
import "./skills.css"

export interface SkillsPanelProps {
  readonly runtime: ServerRuntime
  readonly sessionID: string | undefined
  /** The session's folder, or the folder of the next new session. */
  readonly directory: string | undefined
  /** Adds a chip to the draft on screen (`suggest.addChip`). */
  readonly addChip: (chip: MentionChip) => unknown
  readonly onClose: () => void
}

let panels = 0

const Import = lazy(() => import("./import"))

export default function SkillsPanel(props: SkillsPanelProps) {
  const text = useSkillsImportText()
  const router = useRouter()
  const id = `own-sk-${++panels}`
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  const [working, setWorking] = createSignal(false)
  const [view, setView] = createSignal<"list" | "import">("list")
  // own.import runs on this PC's service only (09 §5.5); an SSH server's list has no 가져오기 tab.
  const importable = () => props.runtime.kind !== "ssh" && props.runtime.imports.allowed("skills.list")
  const [skills, { refetch }] = createResource(
    () => props.directory,
    (directory) => loadSkills(props.runtime, directory),
  )
  // The data layer's list follows `skill.updated` (a switch folded the folder's skills again); the first load fills it.
  const listed = () =>
    (props.directory ? props.runtime.data.location.skill.list({ directory: props.directory }) : undefined) ??
    skills.latest
  const views = createMemo(() => skillViews(listed() ?? [], props.directory))
  // own.accounts keeps the switches on this PC's service only (SG).
  const switchable = () =>
    props.runtime.kind !== "ssh" && props.runtime.rpc.allowed("skillset.switch") && props.directory !== undefined
  const [offView, { refetch: refetchOff }] = createResource(
    () =>
      props.runtime.kind !== "ssh" && props.runtime.rpc.allowed("skillset.view") && props.directory
        ? {
            directory: props.directory,
            ids: views()
              .map((skill) => skill.id)
              .join("\n"),
          }
        : undefined,
    (source) => props.runtime.rpc.call("skillset.view", { directory: source.directory }),
  )
  // A switch folds this folder's skills again; core's announcement of that names no Location, so read them here.
  const reread = () => {
    if (props.directory) void reloadSkills(props.runtime, props.directory)
    void refetchOff()
  }
  onCleanup(props.runtime.own.on("skillset.changed", reread))
  const offRows = () => (offView.error ? [] : (offView.latest?.off ?? []))
  const [switching, setSwitching] = createSignal(false)
  const matches = createMemo(() => filterSkills(views(), query()))
  const shown = createMemo(() => matches().slice(0, VISIBLE_SKILLS))
  const current = () => shown()[Math.min(active(), shown().length - 1)]
  const blocked = () =>
    runBlock({
      sessionID: props.sessionID,
      busy: props.sessionID ? props.runtime.data.session.status(props.sessionID) === "running" : false,
      child: props.sessionID ? !!props.runtime.data.session.get(props.sessionID)?.parentID : false,
      canPrompt: props.runtime.rpc.can("prompt"),
    })

  let input: HTMLInputElement | undefined
  let root: HTMLDivElement | undefined
  const composing = () => enter.composing()

  function add(skill = current()) {
    if (!skill) return
    props.addChip({ kind: "skill", id: skill.id, name: skill.name })
    showToast({ message: text("own.skills.added", { name: skill.name }) })
    props.onClose()
  }

  async function run(skill = current()) {
    const sessionID = props.sessionID
    if (!skill || !sessionID || blocked() || working()) return
    setWorking(true)
    try {
      await runSkill(props.runtime, sessionID, skill.id)
      showToast({ message: text("own.skills.started", { name: skill.name }) })
      props.onClose()
    } catch (error) {
      console.error("[own-web] session.skill", error)
      showToast({ tone: "danger", message: text("own.skills.runFailed", { name: skill.name }) })
    } finally {
      setWorking(false)
    }
  }

  const enter = createImeEnter({
    commitOnly: true,
    onEnter: (modifier) => (modifier ? void run() : add()),
  })

  function keydown(event: KeyboardEvent) {
    if (enter.keydown(event)) return
    if (isImeKey(event, composing())) return
    const code = eventCode(event)
    if (code === "ArrowDown" || code === "ArrowUp") {
      const length = shown().length
      if (!length) return
      event.preventDefault()
      setActive((index) => (index + (code === "ArrowDown" ? 1 : -1) + length) % length)
      document.getElementById(`${id}-${active()}`)?.scrollIntoView({ block: "nearest" })
      return
    }
    if (code === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      props.onClose()
    }
  }

  const outside = (event: PointerEvent) => {
    if (event.target instanceof Node && root?.parentElement?.contains(event.target)) return
    props.onClose()
  }
  onMount(() => {
    fitMenu(root)
    input?.focus()
    document.addEventListener("pointerdown", outside, true)
  })
  onCleanup(() => document.removeEventListener("pointerdown", outside, true))

  const blockText = (): SkillsImportKey | undefined => {
    const reason = blocked()
    if (reason === "noSession" || reason === "child" || reason === "scope") return "own.skills.noSession"
    if (reason === "busy") return "own.skills.busy"
    return undefined
  }

  /** The switch of `id` at exactly the popover's folder, as `되돌리기` puts it back (`null`: none). */
  const atFolder = (id: string) => {
    const directory = props.directory
    const found = (offView.latest?.switches ?? []).find(
      (item) =>
        item.id === id && item.directory !== undefined && directory !== undefined && same(item.directory, directory),
    )
    return found?.enabled ?? null
  }

  /** One project switch for the popover's folder; its toast offers `되돌리기`. */
  async function setHere(id: string, name: string, enabled: boolean, undo = true) {
    const directory = props.directory
    if (!directory || switching()) return
    const before = atFolder(id)
    setSwitching(true)
    const done = await props.runtime.rpc.call("skillset.switch", { changes: [{ id, directory, enabled }] }).then(
      () => true,
      (error: unknown) => {
        console.error("[own-web] skillset.switch", error)
        return false
      },
    )
    setSwitching(false)
    if (!done) return showToast({ tone: "danger", message: text("own.skills.off.failed") })
    reread()
    if (!undo) return showToast({ message: text("own.skills.off.reverted") })
    showToast({
      message: text(enabled ? "own.skills.off.toastOn" : "own.skills.off.toastOff", { name }),
      action: {
        label: text("own.skills.off.undo"),
        run: () =>
          void props.runtime.rpc.call("skillset.switch", { changes: [{ id, directory, enabled: before }] }).then(
            () => {
              reread()
              showToast({ message: text("own.skills.off.reverted") })
            },
            () => showToast({ tone: "danger", message: text("own.skills.off.failed") }),
          ),
      },
    })
  }

  /** `켜기` of a skill switched off here: this folder's switch on (a stored `off` here is deleted by own.accounts). */
  function turnOn(row: OwnSkillset.Off) {
    void setHere(row.id, row.name ?? row.id, true)
  }

  const openSettings = () => {
    props.onClose()
    router.navigate({ name: "settings", section: "skills" })
  }

  /** 설정 > 스킬 shows this PC's skills: only from a window of this PC's server. */
  const manage = () => (
    <Show when={props.runtime.kind !== "ssh"}>
      <button
        type="button"
        class="own-sk-link own-sk-manage"
        data-testid="skills-manage"
        onClick={() => {
          props.onClose()
          router.navigate({ name: "settings", section: "skills" })
        }}
      >
        {text("own.skills.import.manage")}
      </button>
    </Show>
  )

  const tabs = () => (
    <div class="own-sk-tabbar">
      <Show when={importable()}>
        <div class="own-sk-tabs" role="tablist" aria-label={text("own.skills.title")}>
          <For each={["list", "import"] as const}>
            {(tab) => (
              <button
                type="button"
                role="tab"
                class="own-sk-tab"
                aria-selected={view() === tab}
                data-testid={`skills-tab-${tab}`}
                onClick={() => {
                  setView(tab)
                  if (tab === "list") requestAnimationFrame(() => input?.focus())
                }}
              >
                {text(tab === "list" ? "own.skills.tab.list" : "own.skills.tab.import")}
              </button>
            )}
          </For>
        </div>
      </Show>
      {manage()}
    </div>
  )

  return (
    <div
      ref={root}
      class="own-sk-pop"
      role="dialog"
      aria-label={text("own.skills.title")}
      data-testid="skills-panel"
      data-view={view()}
      onKeyDown={(event) => {
        if (view() !== "import" || eventCode(event) !== "Escape") return
        event.preventDefault()
        event.stopPropagation()
        props.onClose()
      }}
    >
      {tabs()}
      <Show
        when={view() === "list"}
        fallback={
          <Suspense fallback={<p class="own-sk-state">{text("own.skills.import.loading")}</p>}>
            <Import
              runtime={props.runtime}
              loaded={() =>
                skills.latest === undefined ? undefined : views().map((skill) => ({ id: skill.id, path: skill.path }))
              }
              directory={() => props.directory}
              onLeave={props.onClose}
            />
          </Suspense>
        }
      >
        <input
          ref={input}
          class="own-sk-search"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={current() ? `${id}-${Math.min(active(), shown().length - 1)}` : undefined}
          aria-label={text("own.skills.search")}
          placeholder={text("own.skills.search")}
          autocomplete="off"
          spellcheck={false}
          data-testid="skills-search"
          onKeyDown={keydown}
          onKeyUp={(event) => enter.keyup(event)}
          onCompositionStart={() => enter.compositionstart()}
          onCompositionEnd={() => enter.compositionend()}
          onInput={(event) => {
            enter.input()
            // Filtering during a composition only redraws the list, never the input (03 §12 rule 5).
            setQuery(event.currentTarget.value)
            setActive(0)
          }}
        />
        <Show
          when={!skills.loading || skills.latest}
          fallback={<p class="own-sk-state">{text("own.skills.loading")}</p>}
        >
          <Show
            when={!skills.error}
            fallback={
              <p class="own-sk-state" data-tone="danger">
                {text("own.skills.failed")}{" "}
                <button type="button" class="own-sk-link" onClick={() => void refetch()}>
                  {text("own.skills.retry")}
                </button>
              </p>
            }
          >
            <Show
              when={shown().length}
              fallback={
                <p class="own-sk-state" data-testid="skills-empty">
                  {views().length ? text("own.skills.noMatch") : text("own.skills.empty")}
                </p>
              }
            >
              <ul id={`${id}-list`} class="own-sk-list" role="listbox" aria-label={text("own.skills.title")}>
                <For each={shown()}>
                  {(skill, index) => (
                    <SkillOption
                      skill={skill}
                      id={`${id}-${index()}`}
                      selected={index() === Math.min(active(), shown().length - 1)}
                      onPoint={() => setActive(index())}
                      onChoose={() => add(skill)}
                      onOff={switchable() ? () => void setHere(skill.id, skill.name, false) : undefined}
                      busy={switching()}
                    />
                  )}
                </For>
              </ul>
              <Show when={matches().length > shown().length}>
                <p class="own-sk-state">{text("own.skills.more", { n: matches().length - shown().length })}</p>
              </Show>
            </Show>
          </Show>
        </Show>
        <Show when={offRows().length > 0}>
          <details class="own-sk-off" data-testid="skills-off-group">
            <summary>{text("own.skills.off.group", { n: offRows().length })}</summary>
            <For each={offRows()}>
              {(row) => (
                <div class="own-sk-off-row" data-testid="skills-off-row" data-skill={row.id} data-by={row.by}>
                  <span class="own-sk-name">{row.name ?? row.id}</span>
                  <code class="own-sk-id">@{row.id}</code>
                  <span class="own-sk-tag">{text(`own.skills.off.by.${row.by}`)}</span>
                  <span class="own-sk-grow" />
                  <Show
                    when={row.by !== "scope" && switchable()}
                    fallback={
                      <Show when={props.runtime.kind !== "ssh"}>
                        <button
                          type="button"
                          class="own-sk-link"
                          data-testid="skills-off-settings"
                          onClick={openSettings}
                        >
                          {text("own.skills.off.settings")}
                        </button>
                      </Show>
                    }
                  >
                    <button
                      type="button"
                      class="own-sk-off-btn"
                      disabled={switching()}
                      data-testid="skills-off-on"
                      onClick={() => turnOn(row)}
                    >
                      {text("own.skills.off.on")}
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </details>
        </Show>
        <div class="own-sk-actions">
          <button type="button" class="own-sk-btn" disabled={!current()} data-testid="skills-add" onClick={() => add()}>
            {text("own.skills.addChip")}
          </button>
          <button
            type="button"
            class="own-sk-btn"
            data-primary
            disabled={!current() || !!blocked() || working()}
            title={blockText() ? text(blockText()!) : undefined}
            data-testid="skills-run"
            onClick={() => void run()}
          >
            {text("own.skills.run")}
          </button>
          <Show when={blockText()}>{(key) => <span class="own-sk-block">{text(key())}</span>}</Show>
        </div>
        <p class="own-sk-note">
          {text("own.skills.chipHint")} {text("own.skills.runHint")}
        </p>
        <p class="own-sk-keys" aria-hidden="true">
          {text("own.skills.keys")}
        </p>
      </Show>
    </div>
  )
}

function SkillOption(props: {
  readonly skill: SkillView
  readonly id: string
  readonly selected: boolean
  readonly onPoint: () => void
  readonly onChoose: () => void
  /** `끄기` (SG): this skill off in the popover's folder; absent where switches are not kept. */
  readonly onOff?: () => void
  readonly busy?: boolean
}) {
  const text = useSkillsImportText()
  return (
    <li class="own-sk-optrow" role="none">
      <div
        id={props.id}
        class="own-sk-option"
        role="option"
        aria-selected={props.selected}
        data-testid="skills-option"
        data-skill={props.skill.id}
        onPointerMove={props.onPoint}
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onChoose}
      >
        <span class="own-sk-icon" aria-hidden="true">
          ✦
        </span>
        <span class="own-sk-main">
          <span class="own-sk-line">
            <span class="own-sk-name">{props.skill.name}</span>
            <code class="own-sk-id">@{props.skill.id}</code>
            <span class="own-sk-tag">{text(`own.skills.source.${props.skill.source}`)}</span>
            <Show when={props.skill.auto}>
              <span class="own-sk-tag" title={text("own.skills.autoHint")}>
                {text("own.skills.auto")}
              </span>
            </Show>
          </span>
          <Show when={props.skill.description}>
            <span class="own-sk-desc">{props.skill.description}</span>
          </Show>
        </span>
      </div>
      <Show when={props.onOff}>
        {(off) => (
          <button
            type="button"
            class="own-sk-off-btn"
            title={text("own.skills.off.title")}
            aria-label={`${text("own.skills.off.title")}: ${props.skill.name}`}
            disabled={props.busy}
            data-testid="skills-option-off"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => off()()}
          >
            {text("own.skills.off.button")}
          </button>
        )}
      </Show>
    </li>
  )
}

function same(a: string, b: string) {
  const norm = (value: string) => {
    const slashed = value.replaceAll("\\", "/").replace(/\/+$/, "")
    return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed
  }
  return norm(a) === norm(b)
}
