// Skills module entry (03 §19.6, gap 22): the skill list (`GET /api/skill`, the data layer's per-location catalog)
// as a popover from the composer toolbar, `칩으로 추가` (a `skill` mention chip, sent as `skills[]` with the next
// message) and `바로 실행` (`POST /api/experimental/session/:id/skill`). The `@` skill group and `/skills <name>` are
// src/mentions + src/commands (they already add the same chip); this module adds the browsable list and the direct run.
//
// Wiring (integrator):
//   composer toolbar (after `＋`): `<SkillsButton runtime={runtime} sessionID={props.sessionID} directory={directory}
//     addChip={suggest.addChip} disabled={() => child() || shell.active()} />`.
//   `/skills` without an argument: keep the inline argument list, or open the popover instead with `openSkills()`
//     (e.g. an override that returns nothing and calls it); the palette may call `openSkills()` too.
import { createEffect, createRoot, createSignal, lazy, on, Show, Suspense } from "solid-js"
import type { ServerRuntime } from "@/data"
import type { MentionChip } from "@/mentions"
import { useSkillsText } from "./strings"

export { loadSkills, runSkill } from "./actions"
export {
  filterSkills,
  runBlock,
  skillSource,
  skillViews,
  type RunBlock,
  type SkillSource,
  type SkillView,
} from "./model"
export { skillsEn, skillsKo, skillsText, useSkillsText } from "./strings"

const Panel = lazy(() => import("./panel"))
const prefetch = () => void import("./panel")

const requests = createRoot(() => {
  const [count, setCount] = createSignal(0)
  return { count, bump: () => setCount((value) => value + 1) }
})

/** Opens the skills popover of the composer on screen (palette, `/skills`). */
export function openSkills() {
  requests.bump()
}

export interface SkillsButtonProps {
  readonly runtime: () => ServerRuntime | undefined
  readonly sessionID: () => string | undefined
  /** The session's folder, or the folder of the next new session. */
  readonly directory: () => string | undefined
  readonly addChip: (chip: MentionChip) => unknown
  readonly disabled?: () => boolean
}

/** `✦ 스킬` in the composer toolbar; the popover chunk loads on first open (prefetched on hover or focus). */
export function SkillsButton(props: SkillsButtonProps) {
  const text = useSkillsText()
  const [open, setOpen] = createSignal(false)
  let button: HTMLButtonElement | undefined
  createEffect(
    on(
      requests.count,
      () => {
        if (!props.disabled?.()) setOpen(true)
      },
      { defer: true },
    ),
  )
  createEffect(() => {
    if (props.disabled?.()) setOpen(false)
  })
  const close = () => {
    setOpen(false)
    const composer = document.getElementById("own-composer-input")
    requestAnimationFrame(() => (composer ?? button)?.focus())
  }
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        ref={button}
        type="button"
        class="own-cp-tool own-target"
        data-testid="skills-button"
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-label={text("own.skills.title")}
        title={text("own.skills.open")}
        disabled={props.disabled?.() || !props.runtime()}
        onPointerEnter={prefetch}
        onFocus={prefetch}
        onClick={() => (open() ? close() : setOpen(true))}
      >
        <span aria-hidden="true" class="own-ico own-ico-spark" />
        {/* Hidden on a narrow composer (composer.css), where the model button needs the room. */}
        <span class="own-cp-tool-text" aria-hidden="true">
          {text("own.skills.title")}
        </span>
      </button>
      <Show when={open() && props.runtime()}>
        {(runtime) => (
          <Suspense>
            <Panel
              runtime={runtime()}
              sessionID={props.sessionID()}
              directory={props.directory()}
              addChip={props.addChip}
              onClose={close}
            />
          </Suspense>
        )}
      </Show>
    </span>
  )
}
