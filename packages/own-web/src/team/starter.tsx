// The team main's empty conversation (06 §9.3, 2026-10-16), in the team chunk: what the user can say to the team main,
// as phrases a click puts into the composer (nothing is sent). With no area yet: talk the split over, or ask how the
// team is doing. With areas: also regroup the work folders, split the first area, or take it over for a while (the
// review trimmed the design's seven to five). A second click replaces the phrase the first one put there. The phrases
// hide while the composer holds text they did not put there (the enable dialog's draft, what the user typed), so a
// click never adds to it and never silently does nothing (review); they come back once the composer is empty.
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { onComposerRestore, requestComposerRestore } from "@/attachments/intents"
import { useData, type ServerKey } from "@/data"
import { composerInputID, usePane } from "@/shell/pane-context"
import type { TeamText } from "./model"
import { useTeamText, type TeamKey } from "./strings"
import "./team.css"

/** The phrases with areas, in order; `{area}` is the first active area's name. */
const WITH_AREAS: ReadonlyArray<TeamKey> = [
  "own.team.starter.discuss",
  "own.team.starter.regroup",
  "own.team.starter.status",
  "own.team.starter.split",
  "own.team.starter.pause",
]

/** Phrases the user can send to the team main (06 §9.3): with no area only talking it over and the team's state. */
export function starterPhrases(text: TeamText, input: { readonly areas: ReadonlyArray<string> }) {
  const area = input.areas[0]
  if (area === undefined) return [text("own.team.starter.discuss"), text("own.team.starter.status")]
  return WITH_AREAS.map((key) => text(key, { area }))
}

/** The phrases show while the composer is empty or holds the phrase the last click put there. */
export function starterShown(draft: string, placed: string | undefined) {
  return draft.trim() === "" || draft === placed
}

export default function TeamMainStarter(props: { readonly serverKey: ServerKey; readonly sessionID: string }) {
  const data = useData()
  const text = useTeamText()
  const pane = usePane()
  /** The phrase the last click put into the composer: the next click may replace it, nothing else. */
  const [placed, setPlaced] = createSignal<string>()
  /** This pane's composer text: read on its input, after every restore and once the composer loaded this draft. */
  const [draft, setDraft] = createSignal("")
  const box = () => document.getElementById(composerInputID(pane))
  const read = () => {
    const element = box()
    setDraft(element instanceof HTMLTextAreaElement ? element.value : "")
  }
  onMount(() => {
    read()
    requestAnimationFrame(read)
    const typed = (event: Event) => event.target === box() && read()
    document.addEventListener("input", typed)
    const restored = onComposerRestore(() => requestAnimationFrame(read))
    onCleanup(() => {
      document.removeEventListener("input", typed)
      restored()
    })
  })
  const phrases = createMemo(() => {
    const team = data.get(props.serverKey)?.team
    const place = team?.placeOf(props.sessionID)
    const entry = place ? team?.team(place.teamID) : undefined
    const areas = (entry?.order ?? []).flatMap((id) => {
      const area = entry?.areas[id]
      return area?.state === "active" ? [area.name] : []
    })
    return starterPhrases(text, { areas })
  })

  function fill(phrase: string) {
    // Shown only over an empty composer or the last phrase, so `ifDraft` replaces exactly what is there.
    requestComposerRestore({
      serverKey: props.serverKey,
      sessionID: props.sessionID,
      text: phrase,
      attachments: [],
      mode: "replace",
      ifDraft: draft(),
    })
    setPlaced(phrase)
    requestAnimationFrame(() => document.getElementById("own-composer-input")?.focus())
  }

  return (
    <Show when={phrases().length > 0 && starterShown(draft(), placed())}>
      <section class="mx-auto flex max-w-[640px] flex-col gap-1.5 px-4 py-2" data-testid="team-starter">
        <h3 class="m-0 text-[13px] font-semibold">{text("own.team.starter.title")}</h3>
        <p class="m-0 text-[12px] text-own-muted">{text("own.team.starter.note")}</p>
        <ul class="m-0 flex list-none flex-col gap-1 p-0">
          <For each={phrases()}>
            {(phrase) => (
              <li>
                <button
                  type="button"
                  class="w-full rounded-md border border-own-border bg-transparent px-2 py-1 text-left text-[12.5px] hover:bg-own-hover"
                  data-testid="team-starter-phrase"
                  onClick={() => fill(phrase)}
                >
                  {phrase}
                </button>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  )
}
