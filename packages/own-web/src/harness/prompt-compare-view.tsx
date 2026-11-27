// 설정 > 에이전트 방식's `비교` (10 §3.11, prompt-page.tsx; the logic is prompt-compare.ts): two variants part by part and
// tool by tool, the left side beside the right one (stacked in a narrow column), what differs marked, unchanged
// stretches folded, parts that are the same collapsed to `같음`. Under each changed run, own's changes it shows: title,
// the first sentence of the reason and `자세히`, which opens the manual at that change (10.13). Each part has its own
// copy buttons, and copying a selection gives its real text (`copyReal`). Everything is a button or a `<details>`, so
// the keyboard reaches it all. Marks are told apart without colour too: struck through on the left, underlined on the
// right, and screen readers hear where each starts and ends (`data-sr`, read through `::before` and `::after` so
// copying the text stays clean), and what each glyph stands for, its code points too. The rows and stretches are keyed
// (`keyed`), so a preview for another model or mode updates them in place: what the user opened stays open and the
// focus stays where it was.
import type { OwnHarness } from "@own/protocol/rpc-harness"
import type { PromptID } from "@own/protocol/rpc-harness-routing"
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js"
import { copyText, Tag } from "@/limits/kit"
import { manualBase, openManual } from "@/manual"
import { showToast } from "@/switcher/toast"
import {
  changeAnchor,
  codePoints,
  comparePreviews,
  copyReal,
  firstSentence,
  fold,
  groupSame,
  inks,
  type Glyph,
  type Ink,
  type Piece,
  type Row,
  type Segment,
} from "./prompt-compare"
import { usePromptsText, type PromptsKey } from "./prompt-strings"

type Preview = OwnHarness.PromptPreview
type Change = OwnHarness.PromptChange

export default function CompareView(props: {
  readonly left: Preview
  readonly right: Preview
  readonly changes: ReadonlyArray<Change>
}) {
  const prompts = usePromptsText()
  const comparison = createMemo(() => comparePreviews(props.left, props.right, props.changes))
  const pair = () => (props.right.prompt === "custom" ? "custom" : "reference")
  const differ = (rows: ReadonlyArray<Row>) => rows.filter((row) => !row.same).length
  const summary = () => {
    const parts = comparison().parts
    const tools = comparison().tools
    if (differ(parts) + differ(tools) === 0) return prompts("own.prompts.compare.identical")
    const counts = (rows: ReadonlyArray<Row>) => ({ changed: differ(rows), same: rows.length - differ(rows) })
    return [
      prompts("own.prompts.compare.summary", counts(parts)),
      ...(tools.length === 0 ? [] : [prompts("own.prompts.compare.summaryTools", counts(tools))]),
    ].join(" · ")
  }
  const sameTools = () => comparison().tools.filter((row) => row.same)
  const sides = () => ({ left: props.left.prompt, right: props.right.prompt })
  // The rows are rebuilt on every preview (another model, mode or variant): a row or fold the user opened or closed
  // stays so.
  const [toggled, setToggled] = createSignal<Readonly<Record<string, boolean>>>({})
  const memory: Memory = {
    opened: (key, initial) => toggled()[key] ?? initial,
    toggle: (key, initial) => (open) =>
      setToggled((all) => {
        const next = { ...all }
        if (open === initial) delete next[key]
        if (open !== initial) next[key] = open
        return next
      }),
  }
  const groups = keyed(
    () => groupSame(comparison().parts),
    (group) => (group.rows.length > 1 ? `same:${group.rows[0]!.key}` : group.rows[0]!.key),
  )
  const changedTools = keyed(
    () => comparison().tools.filter((row) => !row.same),
    (row) => row.key,
  )
  return (
    <>
      <section class="own-psec own-pcmp" data-testid="prompt-compare" data-pair={pair()} onCopy={copyReal}>
        <div class="own-psec-head">
          <h2>{prompts(`own.prompts.compare.title.${pair()}`)}</h2>
        </div>
        <p class="own-prompts-note">{prompts(`own.prompts.compare.note.${pair()}`)}</p>
        <Show when={props.right.prompt === "custom" && props.right.applied !== "custom"}>
          <p class="own-prompts-note" data-testid="prompt-compare-nocustom">
            {prompts("own.prompts.compare.noCustom")}
          </p>
        </Show>
        <p class="own-prompts-note" data-testid="prompt-compare-summary">
          {summary()}
        </p>
        <For each={groups.keys()}>
          {(key) => (
            <Show when={groups.get(key)}>
              {(group) => (
                <Show
                  when={group().rows.length > 1}
                  fallback={
                    <PartRow
                      row={group().rows[0]!}
                      sides={sides()}
                      memory={memory}
                      open={memory.opened(group().rows[0]!.key, !group().rows[0]!.same)}
                      onToggle={memory.toggle(group().rows[0]!.key, !group().rows[0]!.same)}
                    />
                  }
                >
                  <SameGroup name={key} rows={group().rows} sides={sides()} memory={memory} />
                </Show>
              )}
            </Show>
          )}
        </For>
      </section>
      <Show when={comparison().tools.length > 0}>
        <section class="own-psec own-pcmp" data-testid="prompt-compare-tools" onCopy={copyReal}>
          <div class="own-psec-head">
            <h2>{prompts("own.prompts.compare.tools")}</h2>
          </div>
          <For each={changedTools.keys()}>
            {(key) => (
              <Show when={changedTools.get(key)}>
                {(row) => (
                  <RowView
                    row={row()}
                    name={row().tool!}
                    mono
                    sides={sides()}
                    memory={memory}
                    open={memory.opened(key, true)}
                    onToggle={memory.toggle(key, true)}
                  />
                )}
              </Show>
            )}
          </For>
          <Show when={sameTools().length > 0}>
            <details
              class="own-pcmp-row"
              data-testid="prompt-compare-tools-same"
              data-same="true"
              open={memory.opened("tools:same", false)}
              onToggle={(event) => memory.toggle("tools:same", false)(event.currentTarget.open)}
            >
              <summary>
                <span class="own-prompts-part-name">
                  {prompts("own.prompts.compare.toolsSame", { count: sameTools().length })}
                </span>
                <Tag tone="soft">{prompts("own.prompts.compare.same")}</Tag>
              </summary>
              <p class="own-mono own-pcmp-names">
                {sameTools()
                  .map((row) => row.tool)
                  .join(", ")}
              </p>
            </details>
          </Show>
        </section>
      </Show>
      <Show when={comparison().elsewhere.length > 0}>
        <section class="own-psec own-pcmp" data-testid="prompt-compare-elsewhere" onCopy={copyReal}>
          <div class="own-psec-head">
            <h2>{prompts("own.prompts.compare.elsewhere")}</h2>
          </div>
          <p class="own-prompts-note">{prompts("own.prompts.compare.elsewhereNote")}</p>
          <div class="own-pcmp-row">
            <For each={comparison().elsewhere}>{(change) => <Note change={change} />}</For>
          </div>
        </section>
      </Show>
    </>
  )
}

/** `자세히`: the manual at this change's entry (10.13), in a build that has the manual. */
export function ManualMore(props: { readonly change: Change }) {
  const prompts = usePromptsText()
  return (
    <Show when={manualBase()}>
      <button
        type="button"
        class="own-link own-pcmp-more"
        data-testid="prompt-change-more"
        data-anchor={changeAnchor(props.change.id)}
        aria-label={prompts("own.prompts.changes.moreLabel", { title: props.change.title })}
        onClick={() => openManual("prompts", changeAnchor(props.change.id))}
      >
        {prompts("own.prompts.changes.more")}
      </button>
    </Show>
  )
}

type Sides = { readonly left: PromptID; readonly right: PromptID }

/** What the user opened or closed, by key, kept apart from the rows, which every preview rebuilds. */
type Memory = {
  readonly opened: (key: string, initial: boolean) => boolean
  readonly toggle: (key: string, initial: boolean) => (open: boolean) => void
}

/** Whether a row's `<details>` is open, and what to remember when the user opens or closes it. */
type Fold = { readonly open: boolean; readonly onToggle: (open: boolean) => void; readonly memory: Memory }

/**
 * A list for a `<For>` over its keys. Each preview brings new row and stretch objects, and a `<For>` over those would
 * replace every element, and the focus inside it with it; over the keys, an element stays while its key does and only
 * its content changes.
 */
function keyed<T>(list: () => ReadonlyArray<T>, key: (item: T) => string) {
  const map = createMemo(() => new Map(list().map((item) => [key(item), item])))
  return { keys: createMemo(() => [...map().keys()]), get: (id: string) => map().get(id) }
}

/** Two or more same parts in a row, folded into one `같은 부분 {n}개` entry with their names. */
function SameGroup(props: {
  readonly name: string
  readonly rows: ReadonlyArray<Row>
  readonly sides: Sides
  readonly memory: Memory
}) {
  const prompts = usePromptsText()
  const rows = keyed(
    () => props.rows,
    (row) => row.key,
  )
  return (
    <details
      class="own-pcmp-row"
      data-testid="prompt-compare-same-group"
      data-same="true"
      open={props.memory.opened(props.name, false)}
      onToggle={(event) => props.memory.toggle(props.name, false)(event.currentTarget.open)}
    >
      <summary>
        <span class="own-prompts-part-name">
          {prompts("own.prompts.compare.sameParts", { count: props.rows.length })}
        </span>
        <Tag tone="soft">{prompts("own.prompts.compare.same")}</Tag>
        <For each={partNames(props.rows, (row) => prompts(`own.prompts.part.${row.kind!}`))}>
          {(entry) => (
            <span class="own-pcmp-chip">
              {entry.count > 1
                ? prompts("own.prompts.compare.partCount", { name: entry.name, count: entry.count })
                : entry.name}
            </span>
          )}
        </For>
      </summary>
      <div class="own-pcmp-group">
        <For each={rows.keys()}>
          {(key) => (
            <Show when={rows.get(key)}>
              {(row) => (
                <PartRow
                  row={row()}
                  sides={props.sides}
                  memory={props.memory}
                  open={props.memory.opened(key, false)}
                  onToggle={props.memory.toggle(key, false)}
                />
              )}
            </Show>
          )}
        </For>
      </div>
    </details>
  )
}

function PartRow(props: { readonly row: Row; readonly sides: Sides } & Fold) {
  const prompts = usePromptsText()
  return (
    <RowView
      row={props.row}
      name={prompts(`own.prompts.part.${props.row.kind!}`)}
      role={props.row.role === undefined ? undefined : prompts(`own.prompts.role.${props.row.role}`)}
      sides={props.sides}
      memory={props.memory}
      open={props.open}
      onToggle={props.onToggle}
    />
  )
}

/** A same group's part names in order, a name repeated in a row counted once (`도구 목록 7개`). */
function partNames(rows: ReadonlyArray<Row>, nameOf: (row: Row) => string) {
  return rows.reduce<Array<{ name: string; count: number }>>((out, row) => {
    const name = nameOf(row)
    const last = out.at(-1)
    if (last?.name === name) last.count++
    if (last?.name !== name) out.push({ name, count: 1 })
    return out
  }, [])
}

function RowView(
  props: {
    readonly row: Row
    readonly name: string
    readonly role?: string
    readonly mono?: boolean
    readonly sides: Sides
  } & Fold,
) {
  const prompts = usePromptsText()
  const runs = () => props.row.segments.filter((segment) => segment.kind === "change").length
  // A stretch is named by its kind and its first line on the left side, which no other stretch of the row shares.
  const segments = keyed(
    () =>
      props.row.segments.map(
        (segment, index, all): Placed => ({
          ...segment,
          at: index === 0 ? "start" : index === all.length - 1 ? "end" : "middle",
        }),
      ),
    (segment) => `${segment.kind}:${segment.line}`,
  )
  const copy = (text: string) =>
    void copyText(text).then((ok) =>
      showToast(
        ok
          ? { message: prompts("own.prompts.copied") }
          : { message: prompts("own.prompts.copyFailed"), tone: "danger" },
      ),
    )
  return (
    <details
      class="own-pcmp-row"
      open={props.open}
      onToggle={(event) => props.onToggle(event.currentTarget.open)}
      data-testid="prompt-compare-row"
      data-key={props.row.key}
      data-same={props.row.same ? "true" : undefined}
    >
      <summary>
        <span class="own-prompts-part-name" classList={{ "own-mono": props.mono === true }}>
          {props.name}
        </span>
        <Show when={props.role}>{(role) => <Tag tone="plain">{role()}</Tag>}</Show>
        <Show
          when={props.row.same}
          fallback={<Tag tone="accent">{prompts("own.prompts.compare.runs", { count: runs() })}</Tag>}
        >
          <Tag tone="soft">{prompts("own.prompts.compare.same")}</Tag>
        </Show>
      </summary>
      <div class="own-pcmp-copy">
        <Show
          when={!props.row.same}
          fallback={
            <button type="button" class="own-btn" data-size="sm" onClick={() => copy(props.row.right ?? "")}>
              {prompts("own.prompts.copy")}
            </button>
          }
        >
          <For each={(["left", "right"] as const).filter((side) => props.row[side] !== undefined)}>
            {(side) => (
              <button
                type="button"
                class="own-btn"
                data-size="sm"
                data-testid={`prompt-compare-copy-${side}`}
                onClick={() => copy(props.row[side] ?? "")}
              >
                {prompts(`own.prompts.compare.copy.${props.sides[side]}`)}
              </button>
            )}
          </For>
        </Show>
      </div>
      <Show
        when={!props.row.same}
        fallback={<pre class="own-mono own-pcmp-text own-pcmp-whole">{props.row.right}</pre>}
      >
        <div class="own-pcmp-body">
          <For each={segments.keys()}>
            {(key) => (
              <>
                <Show when={sameOf(segments.get(key))}>
                  {(segment) => (
                    <Same
                      text={segment().text}
                      at={segment().at}
                      name={`fold:${props.row.key}`}
                      line={segment().line}
                      memory={props.memory}
                    />
                  )}
                </Show>
                <Show when={changeOf(segments.get(key))}>
                  {(segment) => (
                    <Hunk
                      segment={segment()}
                      sides={props.sides}
                      absent={{ left: props.row.left === undefined, right: props.row.right === undefined }}
                    />
                  )}
                </Show>
              </>
            )}
          </For>
        </div>
      </Show>
    </details>
  )
}

/** A stretch with its place among the row's stretches. */
type Placed = Segment & { readonly at: "start" | "middle" | "end" }

function sameOf(segment: Placed | undefined) {
  return segment?.kind === "same" ? segment : undefined
}

function changeOf(segment: Placed | undefined) {
  return segment?.kind === "change" ? segment : undefined
}

/**
 * An unchanged stretch. A long one keeps `keep` lines next to each change and folds the rest behind one button, which
 * stays where it is and keeps the focus while its label, `aria-expanded` and the lines it controls change. Whether it
 * is open is kept by the part and the lines it hides (`name` and the left side's line numbers), so it stays open when
 * the stretches are rebuilt for another approval mode or model.
 */
function Same(props: {
  readonly text: string
  readonly at: "start" | "middle" | "end"
  readonly name: string
  readonly line: number
  readonly memory: Memory
}) {
  const prompts = usePromptsText()
  const id = createUniqueId()
  const folded = () => fold(props.text, props.at)
  const key = () => {
    const first = props.line + folded().first
    return `${props.name}:${first}-${first + folded().count - 1}`
  }
  const open = () => props.memory.opened(key(), false)
  return (
    <div class="own-pcmp-same" data-testid="prompt-compare-same">
      <Show when={folded().count > 0} fallback={<pre class="own-mono own-pcmp-text">{props.text}</pre>}>
        <Show when={folded().head !== ""}>
          <pre class="own-mono own-pcmp-text">{folded().head}</pre>
        </Show>
        <button
          type="button"
          class="own-pcmp-fold"
          aria-expanded={open() ? "true" : "false"}
          aria-controls={id}
          data-testid="prompt-compare-fold"
          data-fold={key()}
          onClick={() => props.memory.toggle(key(), false)(!open())}
        >
          {open()
            ? prompts("own.prompts.compare.linesHide")
            : prompts("own.prompts.compare.lines", { count: folded().count })}
        </button>
        <pre id={id} class="own-mono own-pcmp-text" hidden={!open()} data-testid="prompt-compare-hidden">
          {folded().hidden}
        </pre>
        <Show when={folded().tail !== ""}>
          <pre class="own-mono own-pcmp-text">{folded().tail}</pre>
        </Show>
      </Show>
    </div>
  )
}

function Hunk(props: {
  readonly segment: Extract<Segment, { kind: "change" }>
  readonly sides: Sides
  /** The sides that have no such part or tool at all. */
  readonly absent: { readonly left: boolean; readonly right: boolean }
}) {
  const prompts = usePromptsText()
  const side = (which: "left" | "right", pieces: ReadonlyArray<Piece>) => (
    <div class="own-pcmp-side" data-side={which}>
      <span class="own-pcmp-label">{prompts(`own.prompts.compare.side.${props.sides[which]}`)}</span>
      <Show
        when={pieces.length > 0}
        fallback={
          <p class="own-pcmp-empty">
            {props.absent[which]
              ? prompts(`own.prompts.compare.missing.${props.sides[which]}`)
              : prompts("own.prompts.compare.noLines")}
          </p>
        }
      >
        <pre class="own-mono own-pcmp-text">
          <For each={pieces}>{(piece) => (piece.mark ? <Mark which={which} piece={piece} /> : piece.text)}</For>
        </pre>
      </Show>
    </div>
  )
  return (
    <div class="own-pcmp-hunk" data-testid="prompt-compare-hunk">
      {side("left", props.segment.left)}
      {side("right", props.segment.right)}
      <Show when={props.segment.whitespace}>
        {(kind) => (
          <p class="own-pcmp-note" data-testid="prompt-compare-whitespace" data-kind={kind()}>
            {prompts(`own.prompts.compare.whitespace.${kind()}`)}
          </p>
        )}
      </Show>
      <For each={props.segment.notes}>{(change) => <Note change={change} />}</For>
    </div>
  )
}

/**
 * A marked piece: `<del>` on the left, `<ins>` on the right. Screen readers hear `data-sr` before it and `data-sr-end`
 * after it. Whitespace it would hide is drawn in glyphs (`inks`); the line breaks it ends with are drawn after it, so
 * that its box does not reach into the next line.
 */
function Mark(props: { readonly which: "left" | "right"; readonly piece: Piece }) {
  const prompts = usePromptsText()
  const drawn = () => inks(props.piece)
  const body = () => <For each={drawn().inside}>{(ink) => (typeof ink === "string" ? ink : <Glyphs ink={ink} />)}</For>
  return (
    <>
      {props.which === "left" ? (
        <del
          data-sr={prompts("own.prompts.compare.sr.del")}
          data-sr-end={prompts("own.prompts.compare.sr.delEnd")}
          data-space={props.piece.space ? "true" : undefined}
        >
          {body()}
        </del>
      ) : (
        <ins
          data-sr={prompts("own.prompts.compare.sr.ins")}
          data-sr-end={prompts("own.prompts.compare.sr.insEnd")}
          data-space={props.piece.space ? "true" : undefined}
        >
          {body()}
        </ins>
      )}
      {drawn().after}
    </>
  )
}

/**
 * What screen readers hear for a run of glyphs (`줄바꿈 1개`, `소프트 하이픈 1개 (U+00AD)`: the code points but for
 * plain spaces, tabs, CRs and line breaks); its tooltip says the same.
 */
const GLYPH_NAMES: Record<Glyph, PromptsKey> = {
  break: "own.prompts.compare.sr.breaks",
  space: "own.prompts.compare.sr.spaces",
  tab: "own.prompts.compare.sr.tabs",
  return: "own.prompts.compare.sr.returns",
  nbsp: "own.prompts.compare.sr.nbsp",
  wide: "own.prompts.compare.sr.wide",
  zero: "own.prompts.compare.sr.zero",
  soft: "own.prompts.compare.sr.soft",
  nel: "own.prompts.compare.sr.nel",
  control: "own.prompts.compare.sr.control",
  bidi: "own.prompts.compare.sr.bidi",
  variant: "own.prompts.compare.sr.variant",
  tag: "own.prompts.compare.sr.tag",
  filler: "own.prompts.compare.sr.filler",
}

/**
 * A run of one glyph, boxed. Screen readers hear its name (`data-sr`, through `::before`) instead of the glyph. The
 * glyph is not selectable; the real characters beside it, not drawn, are what copying a selection gives.
 */
function Glyphs(props: { readonly ink: Exclude<Ink, string> }) {
  const prompts = usePromptsText()
  const name = () => {
    // One glyph a character: the glyphs count them.
    const kind = prompts(GLYPH_NAMES[props.ink.glyph], { count: props.ink.text.length })
    const points = codePoints(props.ink.real)
    return points === "" ? kind : `${kind} (${points})`
  }
  return (
    <span class="own-pcmp-ws" data-sr={name()}>
      <span class="own-pcmp-glyph" aria-hidden="true" title={name()}>
        {props.ink.text}
      </span>
      <Show when={props.ink.real !== ""}>
        <span class="own-pcmp-real" aria-hidden="true">
          {props.ink.real}
        </span>
      </Show>
    </span>
  )
}

/** One change in small type: its title, the first sentence of why, `자세히`. */
function Note(props: { readonly change: Change }) {
  return (
    <p class="own-pcmp-note" data-testid="prompt-compare-note" data-id={props.change.id}>
      <b>{props.change.title}</b> {firstSentence(props.change.why)} <ManualMore change={props.change} />
    </p>
  )
}
