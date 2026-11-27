// Reorganization screens of team mode (06 §8.1, §8.2, §9.7), in the team chunk.
// - `proposalCard`: the card of 팀 구성 다시 보기 — the main's proposal (`reorg.propose`) in plain words: one line per
//   action (`· 확인한 뒤 해요` where its plan has a confirm step), each adopted or created area, what the V-rules
//   rejected and why, the suggestions (a retire one with `[끝내기…]`) and the judge's notes. Since 2026-10-16 each
//   action that can run carries its proposal pointer (`item`) and whether it starts checked: 끝내기 never is (`되돌릴
//   수 없어요`), and neither is an action whose area works or is under Main 멈춤 (`plan.skipped`: choosing it makes it
//   wait, and the team's other work waits with it, review), nor one that changes an area the user set up (2026-10-26:
//   rename, split, merge either side, conversion, retire of a `userMade` area, and 다시 만들기 of a stopped or finished
//   one, which carries its mark, 2026-10-27; `· 내가 정한 영역`); refused items and the judge's conversation moves
//   cannot be chosen. `chosenProposal` keeps the chosen ones, without what only the user sets. Pure.
// - `ReorgReview`: the dialog of 팀 구성 다시 보기… (project menu). It asks what to change (`hint`, optional), asks the
//   main (`reorg.propose{hint}`), shows the card with a checkbox per action and applies only the chosen ones by `user`
//   (a working area waits for its safe point, TI-9): `reorg.apply{teamID, proposalID, items}` where own.team has
//   `area-edit` (2026-10-27: it runs them as the judge's, so its answer never sets what only the user sets), else
//   `reorg.apply{teamID, proposal: chosenProposal(…)}`; confirms wait in the op's result card above the team main,
//   which also holds its undo (8.1). `[팀 메인과 상의하기]` puts the proposal into the team main's composer instead
//   (nothing is sent).
// - `retireSuggestions` / `RetireSuggestions`: the service's retire signal (`AreaView.retirable`) as cards above the
//   team main, `제안: '로그인' 영역을 끝낼 수 있습니다(모두 반영됨, 7일 동안 변경 없음) [끝내기…] [무시]` (8.1, 9.7).
//   The program never retires by itself: 끝내기… opens the area menu's 영역 끝내기 panel and 무시 hides the card in this
//   window for this quiet period (TeamStore `ignoreRetire`).
// - The area menu's panels (area-menu.tsx): 나누기, 영역 묶기, 파일 모양 바꾸기, 대화 옮기기, 다시 만들기 (a missing
//   folder's `[다시 만들기]`, 8.8, and 'B 다시 만들기' on a join's card, 8.2: a new area from the area's record) and 영역
//   끝내기. Each ends in the user's own `reorg.apply{teamID, proposal}` (by `user`, 2.7) that view-model.ts builds; what
//   removes a folder still asks in the confirm dialog afterwards.
import type { OwnTeam } from "@own/protocol/rpc-team"
import { createEffect, createMemo, createSignal, createUniqueId, For, Match, Show, Switch } from "solid-js"
import { requestComposerRestore } from "@/attachments/intents"
import { useData, type ServerKey } from "@/data"
import type { TeamOutput } from "@/data/team-rpc"
import { useRouter } from "@/routing/router"
import { minuteNow } from "@/shell/clock"
import { TeamDialog } from "./confirm"
import { openAreaMenu, type AreaTarget } from "./intents"
import { lfsUpload, withLfs } from "./lfs"
import { errorText, type TeamText } from "./model"
import type { TeamEntry } from "./store"
import { useTeamText, type TeamKey } from "./strings"
import { roleLeft, type MoveCandidate } from "./view-model"
import "./team.css"

const DAY_MS = 24 * 60 * 60 * 1000

/** The protocol's limit of `reorg.propose{hint}`. */
const HINT_MAX = 2_000

const BUTTON = "rounded-md border border-own-border px-2 py-0.5 text-[12.5px] hover:bg-own-hover disabled:opacity-50"
const FIELD =
  "w-full rounded-md border border-own-border-input bg-own-bg px-2 py-1 text-[13px] text-own-text outline-offset-[-1px]"
const CHOICE =
  "flex w-full flex-col items-start rounded-md border border-own-border bg-transparent px-2 py-1 text-left text-[12.5px] hover:bg-own-hover aria-pressed:border-own-accent-text aria-pressed:bg-own-accent-soft"

/** A line of the proposal card; `retire`: the slug a retire suggestion names (`[끝내기…]`). */
export interface ProposalLine {
  readonly text: string
  readonly tone?: "muted" | "warn"
  readonly retire?: string
  /** The proposal pointer the line's checkbox stands for (`ops/0`); absent when the line cannot be chosen. */
  readonly item?: string
  /** Whether its checkbox starts checked. */
  readonly checked?: boolean
}

export interface ProposalCard {
  readonly lines: readonly ProposalLine[]
  /** Some line can be chosen, so applying changes something. */
  readonly runs: boolean
}

const SUGGESTED: Readonly<Record<OwnTeam.Suggestion["kind"], TeamKey>> = {
  retire: "own.team.card.suggest.retire",
  convert: "own.team.card.suggest.convert",
  move: "own.team.card.suggest.move",
  split: "own.team.card.suggest.split",
  merge: "own.team.card.suggest.merge",
}

/**
 * 팀 구성 다시 보기 in plain words (06 §8.1, §9.7). `name` resolves an area as the proposal names it (its id, slug or
 * name). Actions the V-rules rejected are not promised: their line says why instead.
 */
export function proposalCard(
  text: TeamText,
  input: {
    readonly proposal: OwnTeam.Proposal
    readonly plan: OwnTeam.Plan
    readonly name: (area: string) => string
    /** The area the proposal names is one the user set up (`Area.userMade`, 2026-10-26); absent: none is. */
    readonly userMade?: (area: string) => boolean
    /**
     * The area the proposal names is a stopped or finished one the user set up: 다시 만들기 from it (`new` or an
     * `areas` row with it as `from`) carries the mark (2026-10-27); absent: none is.
     */
    readonly again?: (area: string) => boolean
    /**
     * The area works with the user directly (`Area.directWork`, 2026-11-14): a step skipped for it waits for the
     * user's hand-back, though the plan's skip says `paused` (the wire keeps that literal); absent: none does.
     */
    readonly direct?: (area: string) => boolean
  },
): ProposalCard {
  const plan = input.plan
  const name = input.name
  // `from` trimmed, and blank or `main` naming the main, as the V-rules read it (own-team judge/validate.ts `startOf`).
  const again = (from: string | undefined) => {
    const named = from?.trim() ?? ""
    return named !== "" && named !== "main" && input.again?.(named) === true
  }
  const marked = (op: OwnTeam.ReorgOp) => {
    if (op.op === "new") return again(op.from)
    const names = op.op === "merge" ? [op.area, op.from] : op.op === "move" ? [] : [op.area]
    return names.some((area) => input.userMade?.(area) === true)
  }
  // A skip of the by-auto plan (Main 멈춤, work) is offered as a wait (2026-10-16); `rejected` holds it too for
  // clients built before `skipped`, so it is read from `skipped` first.
  const skipped = new Map((plan.skipped ?? []).map((entry) => [entry.item, entry]))
  const rejected = (item: string) =>
    skipped.has(item) ? undefined : plan.rejected.find((entry) => entry.item === item)?.why
  const line = (item: string, words: string, retire = false, mine = false): ProposalLine => {
    const why = rejected(item)
    if (why !== undefined) return { text: text("own.team.review.rejected", { what: words, why }), tone: "muted" }
    const asks = plan.steps.some((step) => step.item === item && step.mode === "confirm")
    const said = retire
      ? text("own.team.review.noUndo", { line: words })
      : asks
        ? text("own.team.review.asks", { line: words })
        : words
    const base = mine ? text("own.team.review.userMade", { line: said }) : said
    const wait = skipped.get(item)
    if (wait) {
      const area = name(wait.areaID)
      const key =
        wait.why !== "paused"
          ? "own.team.review.waits"
          : input.direct?.(wait.areaID) === true
            ? "own.team.review.directWaits"
            : "own.team.review.pausedWaits"
      return { text: text(key, { line: base, area }), tone: "warn", item, checked: false }
    }
    // Only what the plan would run can be chosen.
    if (!plan.steps.some((step) => step.item === item))
      return asks || retire ? { text: base, tone: "warn" } : { text: base }
    if (retire || mine) return { text: base, tone: "warn", item, checked: false }
    return asks ? { text: base, tone: "warn", item, checked: true } : { text: base, item, checked: true }
  }
  const areas = (input.proposal.areas ?? []).flatMap((area, index): ProposalLine[] => {
    if (area.adopt)
      return [line(`areas/${index}`, text("own.team.review.adopt", { folder: shortName(area.adopt.worktree) }))]
    if (area.create)
      return [
        line(`areas/${index}`, text("own.team.review.op.new", { name: area.name }), false, again(area.create.from)),
      ]
    return []
  })
  const ops = (input.proposal.ops ?? []).map((op, index) =>
    line(`ops/${index}`, opWords(text, op, name), op.op === "retire", marked(op)),
  )
  const known = new Set([
    ...(input.proposal.areas ?? []).map((_, index) => `areas/${index}`),
    ...(input.proposal.ops ?? []).map((_, index) => `ops/${index}`),
  ])
  return {
    lines: [
      ...areas,
      ...ops,
      // Rejections of other parts (the commands, the heavy or shared folders) still say why.
      ...plan.rejected
        .filter((entry) => !known.has(entry.item) && !skipped.has(entry.item))
        .map(
          (entry): ProposalLine => ({ text: text("own.team.review.rejectedOther", { why: entry.why }), tone: "muted" }),
        ),
      ...(input.proposal.suggest ?? []).map(
        (suggestion): ProposalLine => ({
          text: text(SUGGESTED[suggestion.kind], {
            area: suggestion.area === undefined ? "" : name(suggestion.area),
            folder: suggestion.worktree === undefined ? "" : shortName(suggestion.worktree),
            why: suggestion.why,
          }),
          tone: "muted",
          ...(suggestion.kind === "retire" && suggestion.area !== undefined ? { retire: suggestion.area } : {}),
        }),
      ),
      ...(input.proposal.notes ? [{ text: input.proposal.notes, tone: "muted" as const }] : []),
    ],
    runs: [...areas, ...ops].some((entry) => entry.item !== undefined),
  }
}

/**
 * 팀 메인과 상의하기 (06 §8.1, 2026-10-16): what the user asked for and the proposal's lines still shown, in the user's
 * words; a suggestion closed with 무시 stays out (review).
 */
export function discussDraft(
  text: TeamText,
  input: { readonly lines: readonly ProposalLine[]; readonly ignored: readonly number[]; readonly hint: string },
) {
  const lines = input.lines.flatMap((line, index) => (input.ignored.includes(index) ? [] : [`- ${line.text}`]))
  const wanted = input.hint.trim()
  return [
    ...(wanted ? [text("own.team.review.draftHint", { hint: wanted })] : []),
    text("own.team.review.draft", { lines: lines.join("\n") }),
  ].join("\n")
}

/**
 * The user's choice of a judge proposal (06 §8.1, 2026-10-16): only the chosen ops and areas, nothing else, for an
 * own.team without `area-edit`, which runs it as the user's own proposal. What only the user sets (a new area's model
 * and 에이전트 방식, the user-made mark, 2026-10-26) is left out, whatever the judge wrote (2026-10-27).
 */
export function chosenProposal(proposal: OwnTeam.Proposal, chosen: ReadonlySet<string>): OwnTeam.Proposal {
  const ops = (proposal.ops ?? []).flatMap((op, index): OwnTeam.ReorgOp[] => {
    if (!chosen.has(`ops/${index}`)) return []
    if (op.op !== "new") return [op]
    const { main: _main, harness: _harness, userMade: _userMade, ...judged } = op
    return [judged]
  })
  const areas = (proposal.areas ?? []).flatMap((area, index): OwnTeam.ProposalArea[] => {
    if (!chosen.has(`areas/${index}`)) return []
    const { userMade: _userMade, ...judged } = area
    return [judged]
  })
  return { version: 1, ...(ops.length ? { ops } : {}), ...(areas.length ? { areas } : {}) }
}

function opWords(text: TeamText, op: OwnTeam.ReorgOp, name: (area: string) => string) {
  switch (op.op) {
    case "new":
      return text("own.team.review.op.new", { name: op.name })
    case "rename":
      return text("own.team.review.op.rename", { area: name(op.area), name: op.name })
    case "retire":
      return text("own.team.review.op.retire", { area: name(op.area) })
    case "split":
      return text("own.team.review.op.split", { area: name(op.area), name: op.name })
    case "merge":
      return text("own.team.review.op.merge", { area: name(op.area), from: name(op.from) })
    case "convert":
      return text(op.shape === "code" ? "own.team.review.op.convert.code" : "own.team.review.op.convert.full", {
        area: name(op.area),
      })
    case "move":
      return text("own.team.review.op.move", { area: name(op.area) })
  }
}

/** Each choosable line's default (`checked`) of a card: what a checkbox starts as. */
export function cardDefaults(card: ProposalCard | undefined): ReadonlyMap<string, boolean> {
  return new Map(
    (card?.lines ?? []).flatMap((line) => (line.item ? [[line.item, line.checked === true] as const] : [])),
  )
}

/**
 * The chosen items once the card's defaults changed while it is shown (an area's user-made mark or state changed, from
 * another window or the main's run): an item whose default changed takes the new one, an item no longer choosable is
 * dropped, and the user's other choices stay. Nothing changed: `chosen` itself (the signal stays as it is).
 */
export function rederive(
  chosen: ReadonlySet<string>,
  before: ReadonlyMap<string, boolean>,
  after: ReadonlyMap<string, boolean>,
): ReadonlySet<string> {
  const same = before.size === after.size && [...after].every(([item, on]) => before.get(item) === on)
  if (same) return chosen
  return new Set([
    ...[...chosen].filter((item) => after.has(item) && before.get(item) === after.get(item)),
    ...[...after].flatMap(([item, on]) => (on && before.get(item) !== on ? [item] : [])),
  ])
}

/**
 * An area of the team as a proposal or a suggestion names it: its id, its slug (`ar_<slug>`) or its name, trimmed as
 * the V-rules trim it (own-team judge/validate.ts).
 */
export function areaOf(entry: Pick<TeamEntry, "areas"> | undefined, area: string) {
  if (!entry) return undefined
  const named = area.trim()
  return (
    entry.areas[named] ?? entry.areas[`ar_${named}`] ?? Object.values(entry.areas).find((item) => item.name === named)
  )
}

/**
 * A skipped step of the area waits for the user's hand-back: direct work holds it and Main 멈춤 is off. Under Main 멈춤
 * or 모두 멈추기 the hold that counts is the pause (its menu offers no hand-back then), as on the row and the banner.
 */
export function directWaits(area: Pick<OwnTeam.AreaView, "paused" | "directWork"> | undefined) {
  return area?.directWork !== undefined && area.paused === false
}

/** A retire suggestion card (06 §8.1, §9.7). */
export interface RetireSuggestion {
  readonly areaID: OwnTeam.AreaID
  readonly since: number
  readonly text: string
}

/**
 * The cards of the areas to suggest finishing (TeamStore `retireCandidates`: active, marked retirable by the service
 * — all applied, clean, no change for 7 days — and not ignored): `모두 반영됨, n일 동안 변경 없음`. Pure.
 */
export function retireSuggestions(
  text: TeamText,
  areas: readonly Pick<OwnTeam.AreaView, "id" | "name" | "retirable">[],
  now: number,
): RetireSuggestion[] {
  return areas.flatMap((area): RetireSuggestion[] => {
    const since = area.retirable?.since
    if (since === undefined) return []
    const days = Math.max(1, Math.floor((now - since) / DAY_MS))
    return [
      {
        areaID: area.id,
        since,
        text: text("own.team.card.suggest.retire", {
          area: area.name,
          why: text("own.team.suggest.retirable", { n: days }),
        }),
      },
    ]
  })
}

/** `[끝내기…]`: the area menu at its 영역 끝내기 panel (area-menu.tsx reads `panel`). */
export function openRetirePanel(target: AreaTarget) {
  openAreaMenu({ ...target, panel: "retire" })
}

/** The retire suggestions of a team, above its main conversation (06 §9.7). */
export function RetireSuggestions(props: { readonly serverKey: ServerKey; readonly teamID: string }) {
  const data = useData()
  const text = useTeamText()
  const runtime = () => data.get(props.serverKey)
  const items = createMemo(() =>
    retireSuggestions(text, runtime()?.team.retireCandidates(props.teamID) ?? [], minuteNow()),
  )
  const can = () => {
    const team = runtime()?.team
    return team?.has("reorg.retire") === true && team.rpc.allowed("reorg.apply")
  }
  return (
    <For each={items()}>
      {(item) => (
        <section class="own-team-card" data-testid="team-suggestion" data-area-id={item.areaID}>
          <ul class="own-team-card-lines">
            <li class="own-team-card-line" data-tone="muted">
              <span>{item.text}</span>
            </li>
          </ul>
          <div class="own-team-card-actions">
            <Show when={can()}>
              <button
                type="button"
                class="own-team-btn"
                aria-haspopup="dialog"
                data-testid="team-suggestion-retire"
                onClick={(event) =>
                  openRetirePanel({
                    serverKey: props.serverKey,
                    // SAFETY: the TeamStore holds teams under their own `OwnTeam.TeamID`.
                    teamID: props.teamID as OwnTeam.TeamID,
                    areaID: item.areaID,
                    anchor: event.currentTarget,
                  })
                }
              >
                {text("own.team.action.retire")}
              </button>
            </Show>
            <button
              type="button"
              class="own-team-btn"
              data-testid="team-suggestion-ignore"
              onClick={() => runtime()?.team.ignoreRetire(props.teamID, item.areaID, item.since)}
            >
              {text("own.team.action.ignore")}
            </button>
          </div>
        </section>
      )}
    </For>
  )
}

/**
 * 팀 구성 다시 보기… (06 §8.1, 2026-10-16): asks what to change (optional), the main proposes (`reorg.propose{hint}`, a
 * judge call on the team main), the card shows each action with a checkbox, and only the chosen ones run by the user
 * (`reorg.apply{proposalID, items}`, or `{proposal}` on an own.team without `area-edit`). The result card above the
 * team main then has the confirms and the undo.
 */
export default function ReorgReview(props: {
  readonly serverKey: ServerKey
  readonly teamID: OwnTeam.TeamID
  readonly onClose: () => void
}) {
  const data = useData()
  const router = useRouter()
  const text = useTeamText()
  const id = createUniqueId()
  const runtime = () => data.get(props.serverKey)
  const entry = () => runtime()?.team.team(props.teamID)
  const [phase, setPhase] = createSignal<"ask" | "loading" | "shown" | "applying" | "applied">("ask")
  const [hint, setHint] = createSignal("")
  const [answer, setAnswer] = createSignal<TeamOutput<"reorg.propose">>()
  /** The areas' names as the main proposed: applying may rename one, and the card says what was proposed. */
  const [named, setNamed] = createSignal<Readonly<Record<string, string>>>({})
  const [failure, setFailure] = createSignal<string>()
  const [ignored, setIgnored] = createSignal<readonly number[]>([])
  const [chosen, setChosen] = createSignal<ReadonlySet<string>>(new Set())
  const card = createMemo(() => {
    const value = answer()
    if (!value) return undefined
    return proposalCard(text, {
      proposal: value.proposal,
      plan: value.plan,
      name: (area) => {
        const found = areaOf(entry(), area)
        return (found && named()[found.id]) ?? found?.name ?? area
      },
      userMade: (area) => areaOf(entry(), area)?.userMade !== undefined,
      again: (area) => {
        const found = areaOf(entry(), area)
        return found?.userMade !== undefined && found.state !== "active"
      },
      direct: (area) => directWaits(areaOf(entry(), area)),
    })
  })
  // The card follows the team (a mark or a state changed since the answer): the checkboxes follow the new defaults.
  let derived: { readonly answer: unknown; readonly defaults: ReadonlyMap<string, boolean> } | undefined
  createEffect(() => {
    const value = answer()
    const defaults = cardDefaults(card())
    const before = derived !== undefined && derived.answer === value ? derived.defaults : undefined
    derived = { answer: value, defaults }
    if (before) setChosen((current) => rederive(current, before, defaults))
  })
  const can = () => runtime()?.team.rpc.allowed("reorg.apply") === true
  const retire = () => runtime()?.team.has("reorg.retire") === true && can()
  // The hint as it is sent (trimmed); no native `maxLength`, so a pasted text is not cut silently (2026-11-14).
  const hintLength = () => hint().trim().length

  async function propose() {
    const current = runtime()
    if (!current) return
    setFailure(undefined)
    setPhase("loading")
    const wanted = hint().trim()
    const proposed = await current.team.rpc
      .call("reorg.propose", { teamID: props.teamID, ...(wanted ? { hint: wanted } : {}) })
      .then(
        (output) => ({ ok: true as const, output }),
        (error: unknown) => ({ ok: false as const, error }),
      )
    if (!proposed.ok) {
      setFailure(errorText(text, proposed.error))
      return setPhase("ask")
    }
    setNamed(Object.fromEntries(Object.values(entry()?.areas ?? {}).map((area) => [area.id, area.name])))
    setAnswer(proposed.output)
    setChosen(new Set([...cardDefaults(card())].flatMap(([item, on]) => (on ? [item] : []))))
    setPhase("shown")
  }

  async function apply() {
    const current = runtime()
    const value = answer()
    if (!current || !value || chosen().size === 0) return
    setFailure(undefined)
    setPhase("applying")
    // 2026-10-27: an own.team with `area-edit` runs the chosen items of the stored proposal as the judge's, so its
    // answer never sets what only the user sets; an older one takes them as the user's own proposal.
    const input = current.team.has("area-edit")
      ? { teamID: props.teamID, proposalID: value.proposalID, items: [...chosen()] }
      : { teamID: props.teamID, proposal: chosenProposal(value.proposal, chosen()) }
    // 4.13: a proposal with a new area or a split may need the large-file tool on an SSH host first.
    const refused = await withLfs(
      () => current.team.rpc.call("reorg.apply", input),
      lfsUpload(data, props.serverKey),
    ).then(
      () => undefined,
      (error: unknown) => ({ error }),
    )
    if (refused) setFailure(errorText(text, refused.error))
    setPhase(refused ? "shown" : "applied")
  }

  /** The team main with its composer focused; `draft` goes into the composer first (never sent). */
  function toMain(draft?: string) {
    const main = entry()?.team.main.sessionID
    props.onClose()
    if (!main) return
    router.navigate({ name: "session", serverKey: props.serverKey, sessionID: main })
    requestAnimationFrame(() => {
      if (draft)
        requestComposerRestore({
          serverKey: props.serverKey,
          sessionID: main,
          text: draft,
          attachments: [],
          mode: "fill",
        })
      document.getElementById("own-composer-input")?.focus()
    })
  }

  const discuss = () => toMain(discussDraft(text, { lines: card()?.lines ?? [], ignored: ignored(), hint: hint() }))

  const toggle = (item: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current)
      on ? next.add(item) : next.delete(item)
      return next
    })

  const state = () => {
    if (phase() === "loading") return text("own.team.review.loading")
    if (phase() === "applying") return text("own.team.review.applying")
    if (phase() === "applied") return text("own.team.review.applied")
    if (phase() === "ask") return undefined
    return failure() || card()?.runs ? undefined : text("own.team.review.nothing")
  }

  return (
    <TeamDialog
      id={id}
      testid="team-review"
      role="dialog"
      busy={() => phase() === "loading" || phase() === "applying"}
      onClose={props.onClose}
      title={text("own.team.menu.review")}
      actions={
        <Switch>
          <Match when={phase() === "ask" || phase() === "loading"}>
            <button type="button" class="own-team-btn" onClick={() => props.onClose()}>
              {text("own.team.action.close")}
            </button>
            <button
              type="button"
              class="own-team-btn"
              data-primary
              disabled={phase() === "loading" || hintLength() > HINT_MAX}
              data-testid="team-review-propose"
              onClick={() => void propose()}
            >
              {text("own.team.review.ask.submit")}
            </button>
          </Match>
          <Match when={phase() === "shown" || phase() === "applying"}>
            <button type="button" class="own-team-btn" onClick={() => props.onClose()}>
              {text("own.team.action.close")}
            </button>
            <Show when={entry()}>
              <button type="button" class="own-team-btn" data-testid="team-review-discuss" onClick={discuss}>
                {text("own.team.review.discuss")}
              </button>
            </Show>
            <Show when={card()?.runs}>
              <button
                type="button"
                class="own-team-btn"
                data-primary
                disabled={chosen().size === 0 || !can() || phase() === "applying"}
                data-testid="team-review-apply"
                onClick={() => void apply()}
              >
                {text("own.team.review.apply", { n: chosen().size })}
              </button>
            </Show>
          </Match>
          <Match when={phase() === "applied"}>
            <Show when={entry()}>
              <button type="button" class="own-team-btn" data-primary onClick={() => toMain()}>
                {text("own.team.action.talkToMain")}
              </button>
            </Show>
            <button type="button" class="own-team-btn" data-autofocus onClick={() => props.onClose()}>
              {text("own.team.action.close")}
            </button>
          </Match>
        </Switch>
      }
    >
      <Show when={phase() === "ask" || phase() === "loading"}>
        <label class="flex flex-col gap-1 text-[12.5px] text-own-muted">
          {text("own.team.review.ask.label")}
          <textarea
            class={FIELD}
            rows={3}
            placeholder={text("own.team.review.ask.placeholder")}
            value={hint()}
            disabled={phase() === "loading"}
            data-autofocus
            data-testid="team-review-hint"
            onInput={(event) => setHint(event.currentTarget.value)}
          />
        </label>
        <span
          class="self-end text-[11.5px]"
          classList={{ "text-own-muted": hintLength() <= HINT_MAX, "text-own-danger": hintLength() > HINT_MAX }}
          data-testid="team-review-hint-count"
        >
          {text("own.team.review.ask.count", {
            n: hintLength().toLocaleString("en-US"),
            max: HINT_MAX.toLocaleString("en-US"),
          })}
        </span>
        <p class="own-team-dialog-body text-[12px] text-own-muted">{text("own.team.review.ask.note")}</p>
      </Show>
      <Show when={state()}>
        {(line) => (
          <p class="own-team-dialog-body" role="status" data-testid="team-review-state">
            {line()}
          </p>
        )}
      </Show>
      <Show when={failure()}>
        {(message) => (
          <p class="own-team-dialog-body" data-tone="danger" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={phase() !== "ask" && phase() !== "loading" && card()}>
        {(shown) => (
          <>
            <Show when={shown().runs && phase() === "shown"}>
              <p class="own-team-dialog-body text-[12.5px]">{text("own.team.review.choose")}</p>
            </Show>
            <ul class="own-team-card-lines" data-testid="team-review-lines">
              <For each={shown().lines}>
                {(line, index) => (
                  <Show when={!ignored().includes(index())}>
                    <li class="own-team-card-line" data-tone={line.tone} data-testid="team-review-line">
                      <Show when={line.item} fallback={<span>{line.text}</span>}>
                        {(item) => (
                          <label class="flex items-start gap-1.5">
                            <input
                              type="checkbox"
                              class="mt-0.5 flex-none"
                              checked={chosen().has(item())}
                              disabled={phase() !== "shown"}
                              data-testid="team-review-check"
                              data-item={item()}
                              onChange={(event) => toggle(item(), event.currentTarget.checked)}
                            />
                            <span>{line.text}</span>
                          </label>
                        )}
                      </Show>
                      <Show when={line.retire === undefined ? undefined : areaOf(entry(), line.retire)}>
                        {(area) => (
                          <>
                            <Show when={retire()}>
                              <button
                                type="button"
                                class="own-team-link"
                                aria-haspopup="dialog"
                                onClick={() => {
                                  props.onClose()
                                  openRetirePanel({
                                    serverKey: props.serverKey,
                                    teamID: props.teamID,
                                    areaID: area().id,
                                  })
                                }}
                              >
                                {text("own.team.action.retire")}
                              </button>
                            </Show>
                            <button
                              type="button"
                              class="own-team-link"
                              onClick={() => setIgnored((list) => [...list, index()])}
                            >
                              {text("own.team.action.ignore")}
                            </button>
                          </>
                        )}
                      </Show>
                    </li>
                  </Show>
                )}
              </For>
            </ul>
          </>
        )}
      </Show>
    </TeamDialog>
  )
}

/** 나누기… (06 §8.2): the new area's name and what it is for. */
export function SplitPanel(props: {
  readonly text: TeamText
  readonly busy: boolean
  readonly area: string
  /** The longest role the server keeps (`roleMax`). */
  readonly max: number
  readonly onSubmit: (name: string, goal: string) => void
  readonly onCancel: () => void
}) {
  const [name, setName] = createSignal("")
  const [goal, setGoal] = createSignal("")
  const left = () => roleLeft(goal(), props.max)
  const over = createUniqueId()
  return (
    <form
      class="flex flex-col gap-1.5 px-2.5 py-1.5"
      aria-label={props.text("own.team.split.title", { area: props.area })}
      data-testid="area-split"
      onSubmit={(event) => {
        event.preventDefault()
        if (name().trim() && left() >= 0) props.onSubmit(name(), goal())
      }}
    >
      <p class="m-0 font-semibold">{props.text("own.team.split.title", { area: props.area })}</p>
      <label class="flex flex-col gap-0.5 text-[12px] text-own-muted">
        {props.text("own.team.newArea.name")}
        <input
          class={FIELD}
          value={name()}
          maxLength={40}
          data-testid="area-split-name"
          onInput={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label class="flex flex-col gap-0.5 text-[12px] text-own-muted">
        {props.text("own.team.newArea.goal")}
        <input
          class={FIELD}
          value={goal()}
          aria-describedby={over}
          aria-invalid={left() < 0}
          data-testid="area-split-goal"
          onInput={(event) => setGoal(event.currentTarget.value)}
        />
      </label>
      <span id={over} class="text-[11.5px] text-own-danger empty:hidden" aria-live="polite">
        <Show when={left() < 0}>
          <span data-testid="area-split-goal-over">{props.text("own.team.createArea.roleOver", { n: -left() })}</span>
        </Show>
      </span>
      <p class="m-0 text-[11.5px] text-own-muted">{props.text("own.team.split.hint", { area: props.area })}</p>
      <span class="flex justify-end gap-1.5">
        <button type="button" class={BUTTON} onClick={() => props.onCancel()}>
          {props.text("own.team.action.cancel")}
        </button>
        <button
          type="submit"
          class={BUTTON}
          disabled={props.busy || !name().trim() || left() < 0}
          data-testid="area-split-save"
        >
          {props.text("own.team.split.do")}
        </button>
      </span>
    </form>
  )
}

/** 영역 묶기… (06 §8.2 A + B → A): which other area goes into this one; nothing happens until `묶기`. */
export function MergePanel(props: {
  readonly text: TeamText
  readonly busy: boolean
  readonly area: string
  readonly peers: readonly { readonly id: OwnTeam.AreaID; readonly name: string }[]
  readonly onPick: (from: OwnTeam.AreaID) => void
  readonly onCancel: () => void
}) {
  const [picked, setPicked] = createSignal<OwnTeam.AreaID>()
  const chosen = () => props.peers.find((peer) => peer.id === picked())
  return (
    <div
      role="group"
      aria-label={props.text("own.team.merge.title", { area: props.area })}
      class="flex flex-col gap-1.5 px-2.5 py-1.5"
      data-testid="area-merge"
    >
      <p class="m-0 font-semibold">{props.text("own.team.merge.title", { area: props.area })}</p>
      <Show
        when={props.peers.length > 0}
        fallback={<p class="m-0 text-own-muted">{props.text("own.team.merge.none")}</p>}
      >
        <ul class="m-0 flex max-h-[40vh] list-none flex-col gap-1 overflow-y-auto p-0">
          <For each={props.peers}>
            {(peer) => (
              <li>
                <button
                  type="button"
                  class={CHOICE}
                  aria-pressed={picked() === peer.id}
                  data-testid="area-merge-peer"
                  onClick={() => setPicked(peer.id)}
                >
                  {peer.name}
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <p class="m-0 text-[11.5px] text-own-muted">{props.text("own.team.merge.hint", { area: props.area })}</p>
      <span class="flex justify-end gap-1.5">
        <button type="button" class={BUTTON} onClick={() => props.onCancel()}>
          {props.text("own.team.action.cancel")}
        </button>
        <button
          type="button"
          class={BUTTON}
          disabled={props.busy || !chosen()}
          data-testid="area-merge-do"
          onClick={() => {
            const peer = chosen()
            if (peer) props.onPick(peer.id)
          }}
        >
          {chosen()
            ? props.text("own.team.merge.item", { from: chosen()!.name })
            : props.text("own.team.areaMenu.merge")}
        </button>
      </span>
    </div>
  )
}

/** 파일 모양 바꾸기 (06 §8.2): what the change does before it starts; focus starts on 취소. */
export function ConvertPanel(props: {
  readonly text: TeamText
  readonly busy: boolean
  readonly area: string
  readonly to: "code" | "full"
  readonly onConfirm: () => void
  readonly onCancel: () => void
}) {
  const title = () =>
    props.text(props.to === "code" ? "own.team.convert.title.code" : "own.team.convert.title.full", {
      area: props.area,
    })
  return (
    <div role="group" aria-label={title()} class="flex flex-col gap-1.5 px-2.5 py-1.5" data-testid="area-convert">
      <p class="m-0 font-semibold">{title()}</p>
      <p class="m-0 text-[12px] text-own-muted">
        {props.text(props.to === "code" ? "own.team.convert.body.code" : "own.team.convert.body.full")}
      </p>
      <span class="flex justify-end gap-1.5">
        <button type="button" class={BUTTON} onClick={() => props.onCancel()}>
          {props.text("own.team.action.cancel")}
        </button>
        <button
          type="button"
          class={BUTTON}
          disabled={props.busy}
          data-testid="area-convert-do"
          onClick={() => props.onConfirm()}
        >
          {props.text("own.team.convert.do")}
        </button>
      </span>
    </div>
  )
}

/** 대화 옮기기… (06 §8.2, §4.14): which conversation continues in this area's folder; nothing moves until `옮기기`. */
export function MovePanel(props: {
  readonly text: TeamText
  readonly busy: boolean
  readonly area: string
  readonly candidates: readonly MoveCandidate[]
  /** A folder as the team view names it (view-model.ts `shortPath`). */
  readonly folder: (directory: string) => string
  readonly onPick: (sessionID: string) => void
  readonly onCancel: () => void
}) {
  const [picked, setPicked] = createSignal<string>()
  return (
    <div
      role="group"
      aria-label={props.text("own.team.move.title", { area: props.area })}
      class="flex flex-col gap-1.5 px-2.5 py-1.5"
      data-testid="area-move"
    >
      <p class="m-0 font-semibold">{props.text("own.team.move.title", { area: props.area })}</p>
      <Show
        when={props.candidates.length > 0}
        fallback={<p class="m-0 text-own-muted">{props.text("own.team.move.none")}</p>}
      >
        <ul class="m-0 flex max-h-[40vh] list-none flex-col gap-1 overflow-y-auto p-0">
          <For each={props.candidates}>
            {(candidate) => (
              <li>
                <button
                  type="button"
                  class={CHOICE}
                  aria-pressed={picked() === candidate.sessionID}
                  data-testid="area-move-session"
                  onClick={() => setPicked(candidate.sessionID)}
                >
                  <span class="line-clamp-1">{candidate.title ?? props.text("own.team.move.untitled")}</span>
                  <span class="text-[11.5px] text-own-muted">{props.folder(candidate.directory)}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <p class="m-0 text-[11.5px] text-own-muted">{props.text("own.team.move.hint")}</p>
      <span class="flex justify-end gap-1.5">
        <button type="button" class={BUTTON} onClick={() => props.onCancel()}>
          {props.text("own.team.action.cancel")}
        </button>
        <button
          type="button"
          class={BUTTON}
          disabled={props.busy || picked() === undefined}
          data-testid="area-move-do"
          onClick={() => {
            const sessionID = picked()
            if (sessionID) props.onPick(sessionID)
          }}
        >
          {props.text("own.team.move.do")}
        </button>
      </span>
    </div>
  )
}

/**
 * 영역 끝내기… (06 §8.2, §8.6, §8.8): what stays, and that the folder is asked about with its list before anything is
 * removed. A missing folder retires without a removal; a finished area whose folder is left (`두기`) removes only that.
 * Focus starts on 취소.
 */
export function RetirePanel(props: {
  readonly text: TeamText
  readonly busy: boolean
  readonly area: string
  readonly kind: "active" | "missing" | "leftover"
  readonly onConfirm: () => void
  readonly onCancel: () => void
}) {
  const body = (): TeamKey =>
    props.kind === "missing"
      ? "own.team.retire.missing"
      : props.kind === "leftover"
        ? "own.team.retire.leftover"
        : "own.team.retire.body"
  return (
    <div
      role="group"
      aria-label={props.text("own.team.retire.title", { area: props.area })}
      class="flex flex-col gap-1.5 px-2.5 py-1.5"
      data-testid="area-retire"
      data-kind={props.kind}
    >
      <p class="m-0 font-semibold">{props.text("own.team.retire.title", { area: props.area })}</p>
      <p class="m-0 text-[12px] text-own-muted">{props.text(body())}</p>
      <span class="flex justify-end gap-1.5">
        <button type="button" class={BUTTON} onClick={() => props.onCancel()}>
          {props.text("own.team.action.cancel")}
        </button>
        <button
          type="button"
          class={`${BUTTON} text-own-danger`}
          disabled={props.busy}
          data-testid="area-retire-confirm"
          onClick={() => props.onConfirm()}
        >
          {props.text("own.team.action.finish")}
        </button>
      </span>
    </div>
  )
}

/**
 * 다시 만들기 (06 §8.8 a missing folder's `[다시 만들기]`, §8.2 'B 다시 만들기'): a new area from the area's record, with
 * a new folder and a new owner conversation; a missing area itself stays until it is finished. Focus starts on 취소.
 */
export function RecreatePanel(props: {
  readonly text: TeamText
  readonly busy: boolean
  readonly area: string
  /** `missing`: the old area stays stopped (8.8); `finished`: B after a join (8.2). */
  readonly kind: "missing" | "finished"
  readonly onConfirm: () => void
  readonly onCancel: () => void
}) {
  return (
    <div
      role="group"
      aria-label={props.text("own.team.recreate.title", { area: props.area })}
      class="flex flex-col gap-1.5 px-2.5 py-1.5"
      data-testid="area-recreate-panel"
      data-kind={props.kind}
    >
      <p class="m-0 font-semibold">{props.text("own.team.recreate.title", { area: props.area })}</p>
      <p class="m-0 text-[12px] text-own-muted">{props.text("own.team.recreate.body", { area: props.area })}</p>
      <Show when={props.kind === "missing"}>
        <p class="m-0 text-[12px] text-own-muted">{props.text("own.team.recreate.missing", { area: props.area })}</p>
      </Show>
      <span class="flex justify-end gap-1.5">
        <button type="button" class={BUTTON} onClick={() => props.onCancel()}>
          {props.text("own.team.action.cancel")}
        </button>
        <button
          type="button"
          class={BUTTON}
          disabled={props.busy}
          data-testid="area-recreate-confirm"
          onClick={() => props.onConfirm()}
        >
          {props.text("own.team.action.recreate")}
        </button>
      </span>
    </div>
  )
}

/** `[다시 만들기]`: the area menu at its 다시 만들기 panel (area-menu.tsx reads `panel`). */
export function openRecreatePanel(target: AreaTarget) {
  openAreaMenu({ ...target, panel: "recreate" })
}

/** The last segment of a path: folders show their short name (06 §9.1). */
function shortName(path: string) {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) || path
  )
}
