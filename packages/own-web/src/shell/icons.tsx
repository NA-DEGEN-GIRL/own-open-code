// Inline stroke icons (same drawing as the prototype). Decorative: the button carries the accessible name.
import { splitProps, type JSX } from "solid-js"

const paths = {
  menu: "M4 7h16M4 12h16M4 17h16",
  panel: "M3.5 4.5h17v15h-17zM14.5 4.5v15",
  sidebar: "M3.5 4.5h17v15h-17zM9.5 4.5v15",
  left: "M15 6l-6 6 6 6",
  right: "M9 6l6 6-6 6",
  plus: "M12 5v14M5 12h14",
  x: "M6 6l12 12M18 6L6 18",
  sun: "M12 8a4 4 0 100 8 4 4 0 000-8zM12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4",
  moon: "M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z",
  system: "M3.5 5.5h17v11h-17zM8 20h8M12 16.5V20",
  // Computer use (01 §10.2): the screen with a pointer on it, so a folded header chip never reads as the theme's
  // `system` screen.
  computer: "M3.5 5.5h17v11h-17zM8 20h8M12 16.5V20M9.5 8l5 2-2.1.8-.8 2.1z",
  // A toothed cog (P2-06a): eight teeth on one outline around the hub, so it never reads as the theme toggle's `sun`
  // (a disc with separate rays).
  gear: "M10.43 5.18l.25-2.59h2.64l.25 2.59a7 7 0 0 1 2.14.88l2.01-1.65 1.87 1.87-1.65 2.01a7 7 0 0 1 .88 2.14l2.59.25v2.64l-2.59.25a7 7 0 0 1-.88 2.14l1.65 2.01-1.87 1.87-2.01-1.65a7 7 0 0 1-2.14.88l-.25 2.59h-2.64l-.25-2.59a7 7 0 0 1-2.14-.88l-2.01 1.65-1.87-1.87 1.65-2.01a7 7 0 0 1-.88-2.14l-2.59-.25v-2.64l2.59-.25a7 7 0 0 1 .88-2.14l-1.65-2.01 1.87-1.87 2.01 1.65a7 7 0 0 1 2.14-.88zM12 9a3 3 0 100 6 3 3 0 000-6z",
  gauge: "M4 16a8 8 0 1116 0M12 16l4-6",
  user: "M12 5a3.5 3.5 0 100 7 3.5 3.5 0 000-7zM5 20a7 7 0 0114 0",
  agent:
    "M12 3.5v3M7 6.5h10a2.5 2.5 0 012.5 2.5v7a2.5 2.5 0 01-2.5 2.5H7A2.5 2.5 0 014.5 16V9A2.5 2.5 0 017 6.5zM9.5 11.5v1.5M14.5 11.5v1.5M2.5 12.5h2M19.5 12.5h2",
  help: "M12 3a9 9 0 100 18 9 9 0 000-18zM9.5 9.5a2.5 2.5 0 015 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01",
  team: "M9 5.5a3 3 0 100 6 3 3 0 000-6zM3.5 19a5.5 5.5 0 0111 0M16 6.5a2.5 2.5 0 110 5M17.5 14.5a4.5 4.5 0 013 4.5",
  branch:
    "M7 3a2 2 0 100 4 2 2 0 000-4zM7 17a2 2 0 100 4 2 2 0 000-4zM17 5a2 2 0 100 4 2 2 0 000-4zM7 7v10M17 9c0 4-10 3-10 8",
  // The two note features look different on purpose: a bound notebook for the workspace `노트` tab (project notes), a
  // sticky memo with a folded corner for one conversation's `대화 메모`.
  notebook: "M6.5 3.5h12v17h-12zM9.5 3.5v17M4.5 7.5h4M4.5 12h4M4.5 16.5h4M12.5 8h3.5M12.5 11.5h3.5",
  memo: "M4.5 4.5h15v10l-5 5h-10zM14.5 19.5v-5h5M8 8.5h8M8 12h5",
  // Split panes (03 §4.1.1).
  splitRight: "M3.5 4.5h17v15h-17zM12 4.5v15",
  splitDown: "M3.5 4.5h17v15h-17zM3.5 12h17",
  tabs: "M3.5 8.5h17v11h-17zM3.5 8.5v-4h7l1.5 4",
  globe:
    "M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17zM3.5 12h17M12 3.5c2.6 2.7 2.6 14.3 0 17M12 3.5c-2.6 2.7-2.6 14.3 0 17",
  dots: "M5.5 12h.01M12 12h.01M18.5 12h.01",
  pin: "M9 3.5h6l-1 5 3.5 3.5h-11L10 8.5zM12 12v8.5",
  eye: "M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 9.25a2.75 2.75 0 100 5.5 2.75 2.75 0 000-5.5z",
  eyeOff:
    "M4 4l16 16M9.9 5.8A9.9 9.9 0 0112 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 01-3 3.7M14 14a2.75 2.75 0 01-4-3.9M6.2 7.6A16 16 0 002.5 12s3.5 6.5 9.5 6.5a9.6 9.6 0 004.3-1",
  // The speeds (02 §4.8, 2026-10-18): a bolt for Fast, the same bolt with speed lines trailing it for Ultrafast.
  bolt: "M13.5 2.5L5.5 13h6l-1 8.5 8-10.5h-6l1-8.5z",
  boltFast: "M17 3l-6.5 9.5h5l-1 8.5 6.5-9.5h-5l1-8.5zM2.5 9h6M4 15h5.5",
} as const

export type IconName = keyof typeof paths

/** An icon beside text, stroked in the text color without any button stylesheet (14 px by default). */
export function InlineIcon(props: { readonly name: IconName; readonly size?: number; readonly class?: string }) {
  return (
    <Icon
      name={props.name}
      class={props.class}
      width={props.size ?? 14}
      height={props.size ?? 14}
      fill="none"
      stroke="currentColor"
      stroke-width={1.6}
      stroke-linecap="round"
      stroke-linejoin="round"
      style={{ flex: "none" }}
    />
  )
}

export function Icon(props: { readonly name: IconName } & JSX.SvgSVGAttributes<SVGSVGElement>) {
  const [local, rest] = splitProps(props, ["name"])
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...rest}>
      <path d={paths[local.name]} />
    </svg>
  )
}
