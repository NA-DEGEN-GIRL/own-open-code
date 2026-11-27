// 설정 > 단축키 (03 §5.7 "10장 표, 충돌 표시", §10 "단축키 도움말(Ctrl+/)에서 키를 다시 지정할 수 있다. 충돌하면 빨간
// 표시를 한다", 19.15). Lazy with the settings page. The capture follows upstream settings/keybinds (click, press the
// new chord; Esc cancels, Backspace clears) with own rules: chords by `event.code` (IME-safe: keys an IME owns are
// never recorded), no chord the browser/OS/IME/zoom/text editing/focused surfaces keep, no chord that another action
// already uses (the message names it). The conflict check audits the whole effective keymap and the handlers this
// window registered, and lists the 03 §10 upstream decisions.
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useHost } from "@/host"
import { useI18n, type I18nKey } from "@/i18n"
import { isImeKey } from "@/ime/ime-enter"
import { chordLabel, chordOf, isMac, useShortcuts } from "@/keyboard"
import { DEFAULT_KEYMAP, type ShortcutID } from "@/keyboard/keymap"
import { ko } from "@/i18n/ko"
import { createStatus, Notice, StatusLine, Tag, TextField } from "@/limits/kit"
import { auditKeymap, browserDefault, checkChord, type ChordProblem, type DecisionID } from "./audit"
import { matchCandidate, parseQuery, prepare } from "./fuzzy"
import { effectiveKeymap, keymapOverrides, resetAllChords, resetChords, setChords } from "./keymap-store"
import { usePaletteText, type PaletteKey } from "./strings"
import "./keys.css"

const IDS = Object.keys(DEFAULT_KEYMAP) as ShortcutID[]
const DECISION_KEY: Record<DecisionID, PaletteKey> = {
  sidebar: "own.keys.decision.sidebar",
  switcher: "own.keys.decision.switcher",
  selection: "own.keys.decision.selection",
  approval: "own.keys.decision.approval",
  window: "own.keys.decision.window",
  newSession: "own.keys.decision.newSession",
}

export default function ShortcutSettings() {
  const i18n = useI18n()
  const text = usePaletteText()
  const host = useHost()
  const registry = useShortcuts()
  const status = createStatus()
  const keymap = createMemo(effectiveKeymap)
  const audit = createMemo(() => auditKeymap(keymap(), { mac: isMac }))
  // Handlers are registered by mounted components; the page is opened after the shell is up.
  const live = new Set(registry.registered())
  // A browser tab has a menu of its own; the desktop window (title bar band) does not (05 §7.7).
  const inBrowser = !host.capabilities.windowControlsOverlay
  const [capturing, setCapturing] = createSignal<ShortcutID>()
  const [problem, setProblem] = createSignal<{ id: ShortcutID; message: string }>()
  const [query, setQuery] = createSignal("")

  const label = (id: ShortcutID) => {
    const key = `own.set.sc.${id}`
    return key in ko ? i18n.t(key as I18nKey) : id
  }
  const keys = (id: ShortcutID) => keymap()[id].chords.map((chord) => chordLabel(chord))
  const issuesOf = (id: ShortcutID) => audit().issues.filter((issue) => issue.id === id)
  const visible = createMemo(() => {
    const terms = parseQuery(query())
    if (!terms.length) return IDS
    return IDS.filter((id) =>
      matchCandidate(terms, { title: prepare(label(id)), keywords: prepare(`${id} ${keys(id).join(" ")}`) }),
    )
  })
  const groups = () =>
    (["global", "composer"] as const).map((scope) => ({
      scope,
      ids: visible().filter((id) => DEFAULT_KEYMAP[id].scope === scope),
    }))

  function describe(id: ShortcutID, chord: string, issue: ChordProblem) {
    const params = { keys: chordLabel(chord) }
    if (issue.kind === "conflict") return text("own.keys.err.conflict", { ...params, action: label(issue.other) })
    if (issue.kind === "composer") return text("own.keys.err.composer", { ...params, where: text(issue.where) })
    if (issue.kind === "win") return text("own.keys.err.win")
    if (issue.kind === "modifier" || issue.kind === "empty") return text("own.keys.err.modifier")
    return text(`own.keys.err.${issue.kind}`, params)
  }

  function start(id: ShortcutID) {
    status.clear()
    setProblem(undefined)
    setCapturing((current) => (current === id ? undefined : id))
  }

  function stop(id: ShortcutID) {
    setCapturing(undefined)
    setProblem(undefined)
    queueMicrotask(() => document.querySelector<HTMLElement>(`[data-keys-button="${id}"]`)?.focus())
  }

  // Capture phase on the document: the registry (window, bubble) never sees keys while a row records.
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      const id = capturing()
      if (!id) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      // Keys the IME owns (a Hangul letter shows up as 229 / "Process") are never recorded (03 §10).
      if (isImeKey(event)) return
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      if (plain && event.code === "Escape") return stop(id)
      if (plain && (event.code === "Backspace" || event.code === "Delete")) {
        setChords(id, [])
        status.ok(text("own.keys.cleared", { action: label(id) }))
        return stop(id)
      }
      const chord = chordOf(event)
      const found = checkChord(keymap(), id, chord, { mac: isMac, win: !isMac && event.metaKey })
      // Modifiers alone: keep waiting for the key.
      if (found?.kind === "empty") return
      if (found) return setProblem({ id, message: describe(id, chord, found) })
      setProblem(undefined)
      setChords(id, [chord])
      status.ok(text("own.keys.saved", { action: label(id), keys: chordLabel(chord) }))
      stop(id)
    }
    const onPointer = (event: PointerEvent) => {
      const id = capturing()
      if (!id || (event.target instanceof Element && event.target.closest(`[data-keys-button="${id}"]`))) return
      setCapturing(undefined)
      setProblem(undefined)
    }
    document.addEventListener("keydown", onKey, { capture: true })
    document.addEventListener("pointerdown", onPointer, { capture: true })
    onCleanup(() => {
      document.removeEventListener("keydown", onKey, { capture: true })
      document.removeEventListener("pointerdown", onPointer, { capture: true })
    })
  })

  return (
    <div class="flex flex-col gap-3" data-testid="settings-shortcuts">
      <p class="m-0 text-[12.5px] text-own-muted">{text("own.keys.intro")}</p>

      <section class="flex flex-col gap-1.5" aria-label={text("own.keys.audit.title")} data-testid="shortcut-audit">
        <Show
          when={audit().issues.length}
          fallback={
            <p class="m-0 text-[12.5px] text-own-ok" data-testid="shortcut-audit-ok">
              ✓ {text("own.keys.audit.ok", { n: audit().checked, live: live.size })}
            </p>
          }
        >
          <Notice tone="danger" testid="shortcut-audit-issues">
            <b>{text("own.keys.audit.issues", { n: audit().issues.length })}</b>
            <ul class="m-0 mt-1 list-disc pl-5">
              <For each={audit().issues}>
                {(issue) => (
                  <li>
                    {label(issue.id)}: {describe(issue.id, issue.chord, issue.problem)}
                  </li>
                )}
              </For>
            </ul>
          </Notice>
        </Show>
        <details class="text-[12.5px]" data-testid="shortcut-decisions">
          <summary class="cursor-pointer text-own-muted">{text("own.keys.audit.decisions")}</summary>
          <ul class="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
            <For each={audit().decisions}>
              {(decision) => (
                <li
                  class="flex items-start gap-2"
                  data-decision={decision.id}
                  data-kept={decision.kept ? "" : undefined}
                >
                  <span class={decision.kept ? "text-own-ok" : "text-own-warn"}>{decision.kept ? "✓" : "•"}</span>
                  <span class="min-w-0 flex-1">{text(DECISION_KEY[decision.id], { mod: isMac ? "⌘" : "Ctrl" })}</span>
                  <Tag tone={decision.kept ? "ok" : "warn"}>
                    {text(decision.kept ? "own.keys.audit.kept" : "own.keys.audit.changed")}
                  </Tag>
                </li>
              )}
            </For>
          </ul>
        </details>
      </section>

      <div class="flex flex-wrap items-end gap-2">
        <div class="min-w-[220px] flex-1">
          <TextField
            label={text("own.keys.search")}
            hideLabel
            placeholder={text("own.keys.search")}
            value={query()}
            onValue={setQuery}
            testid="shortcut-search"
          />
        </div>
        <button
          type="button"
          class="own-btn"
          data-size="sm"
          disabled={!Object.keys(keymapOverrides()).length}
          data-testid="shortcut-reset-all"
          onClick={() => {
            resetAllChords()
            setCapturing(undefined)
            setProblem(undefined)
            status.ok(text("own.keys.resetAll"))
          }}
        >
          {text("own.keys.resetAll")}
        </button>
      </div>
      <StatusLine status={status} testid="shortcut-status" />

      <For each={groups()}>
        {(group) => (
          <Show when={group.ids.length}>
            <table class="own-tbl" data-scope={group.scope}>
              <caption class="pb-1 text-left text-[12.5px] font-semibold text-own-muted">
                {text(group.scope === "global" ? "own.keys.group.global" : "own.keys.group.composer")}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{i18n.t("own.set.action")}</th>
                  <th scope="col">{i18n.t("own.set.keys")}</th>
                </tr>
              </thead>
              <tbody>
                <For each={group.ids}>
                  {(id) => {
                    const custom = () => id in keymapOverrides()
                    const issues = () => issuesOf(id)
                    const web = () =>
                      inBrowser ? keymap()[id].chords.flatMap((chord) => browserDefault(chord, isMac) ?? []) : []
                    return (
                      <tr
                        data-shortcut={id}
                        data-problem={issues().length || problem()?.id === id ? "" : undefined}
                        classList={{ "own-keys-problem": issues().length > 0 || problem()?.id === id }}
                      >
                        <td>
                          <span class="flex flex-wrap items-center gap-1.5">
                            <span>{label(id)}</span>
                            <Show when={custom()}>
                              <Tag tone="accent">{text("own.keys.custom")}</Tag>
                            </Show>
                            <Show when={!live.has(id)}>
                              <Tag tone="dashed" title={text("own.keys.notLiveNote")}>
                                {text("own.keys.notLive")}
                              </Tag>
                            </Show>
                          </span>
                          <Show when={web().length}>
                            <span class="block text-[11.5px] text-own-faint">
                              {text("own.keys.web", {
                                action: web()
                                  .map((key) => text(key))
                                  .join(", "),
                              })}
                            </span>
                          </Show>
                          <For each={issues()}>
                            {(issue) => (
                              <span class="block text-[12px] text-own-danger" role="alert">
                                {describe(id, issue.chord, issue.problem)}
                              </span>
                            )}
                          </For>
                          <Show when={problem()?.id === id}>
                            <span class="block text-[12px] text-own-danger" role="alert" data-testid="shortcut-error">
                              {problem()!.message}
                            </span>
                          </Show>
                        </td>
                        <td>
                          <span class="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              class="own-keys-button"
                              data-keys-button={id}
                              data-capturing={capturing() === id ? "" : undefined}
                              aria-pressed={capturing() === id}
                              aria-label={text("own.keys.change", {
                                action: label(id),
                                keys: keys(id).join(", ") || text("own.keys.unassigned"),
                              })}
                              onClick={() => start(id)}
                            >
                              <Show
                                when={capturing() !== id}
                                fallback={<span class="text-own-accent-text">{text("own.keys.captureShort")}</span>}
                              >
                                <Show
                                  when={keys(id).length}
                                  fallback={<span class="text-own-faint">{text("own.keys.unassigned")}</span>}
                                >
                                  <For each={keys(id)}>
                                    {(value) => (
                                      <kbd class="own-mono rounded border border-own-border bg-own-subtle px-1.5 text-[12px]">
                                        {value}
                                      </kbd>
                                    )}
                                  </For>
                                </Show>
                              </Show>
                            </button>
                            <Show when={custom()}>
                              <button
                                type="button"
                                class="own-btn"
                                data-size="sm"
                                data-testid="shortcut-reset"
                                aria-label={text("own.keys.resetRow", {
                                  action: label(id),
                                  keys: DEFAULT_KEYMAP[id].chords.map((chord) => chordLabel(chord)).join(", "),
                                })}
                                onClick={() => {
                                  resetChords(id)
                                  setProblem(undefined)
                                }}
                              >
                                {text("own.keys.reset")}
                              </button>
                            </Show>
                          </span>
                          <Show when={capturing() === id}>
                            <span class="mt-1 block text-[11.5px] text-own-muted" aria-live="polite">
                              {text("own.keys.capture")}
                            </span>
                          </Show>
                        </td>
                      </tr>
                    )
                  }}
                </For>
              </tbody>
            </table>
          </Show>
        )}
      </For>
      <Show when={query().trim() && !visible().length}>
        <p class="m-0 text-[12.5px] text-own-muted">{text("own.keys.noResults", { query: query().trim() })}</p>
      </Show>
      <p class="m-0 text-[12px] text-own-faint">{i18n.t("own.set.shortcutsIme")}</p>
    </div>
  )
}
