// Inline stroke icons of the files tab (like shell/icons.tsx). Decorative: the control carries the accessible name.
// Deliberately not @opencode/ui `FileIcon`: its sprite is a 955 KB SVG fetched on the first tree row.
import { splitProps, type JSX } from "solid-js"

const paths = {
  search: "M11 4a7 7 0 100 14 7 7 0 000-14zM16 16l4.5 4.5",
  refresh: "M20 12a8 8 0 11-2.34-5.66M20 4v5h-5",
  tree: "M4 5h6M4 5v14M4 12h6M4 19h6M13 5h7M13 12h7M13 19h7",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  chevron: "M9 6l6 6-6 6",
  folder: "M3.5 6.5a1 1 0 011-1h5l2 2h8a1 1 0 011 1v9a1 1 0 01-1 1h-15a1 1 0 01-1-1z",
  file: "M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4",
  editor: "M14 4h6v6M20 4l-9 9M18 14v5.5h-14v-14h5.5",
  x: "M7 7l10 10M17 7L7 17",
} as const

export type FilesIconName = keyof typeof paths

export function FilesIcon(props: { readonly name: FilesIconName } & JSX.SvgSVGAttributes<SVGSVGElement>) {
  const [local, rest] = splitProps(props, ["name"])
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" data-icon={local.name} {...rest}>
      <path d={paths[local.name]} />
    </svg>
  )
}
