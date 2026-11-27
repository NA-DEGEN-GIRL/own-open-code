// The on/off switch of the settings rows (P2-11, 03 §4.2.2): a 36×20 track with its thumb inside a transparent button.
// Under a coarse pointer the button grows to the 44×44 touch target (`.own-target`) and the track stays a centred
// pill, where the switch used to grow into a 44 px blob. Named `ToggleSwitch` because solid-js exports `Switch`
// (settings/team.tsx uses both). Import it only from lazy chunks: its stylesheet is a module of its own, so the first
// chunk never carries it.
import "./switch.css"

export function ToggleSwitch(props: {
  readonly checked: boolean
  /** The accessible name (the row's title or what the switch turns on). */
  readonly label: string
  /** A change in flight: the switch stays focusable but ignores presses. */
  readonly busy?: boolean
  readonly testid?: string
  readonly onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      // aria-disabled, not disabled: a disabled button drops keyboard focus while the change is in flight.
      aria-disabled={props.busy}
      class="own-switch own-target"
      data-testid={props.testid}
      onClick={() => {
        if (!props.busy) props.onChange(!props.checked)
      }}
    >
      <span class="own-switch-track" aria-hidden="true">
        <span class="own-switch-thumb" />
      </span>
    </button>
  )
}
