// A folder path in one muted line (the project and server selectors, 03 §5.1). A path too long for its place loses its
// start, never the folder itself: the ellipsis side is flipped, the text stays LTR (as in files/files.css).
export function PathTail(props: { readonly path: string; readonly class?: string }) {
  return (
    <span
      class={`min-w-0 truncate text-left font-mono text-[11px] text-own-faint [direction:rtl] ${props.class ?? ""}`}
      data-testid="path-tail"
    >
      <bdi dir="ltr">{props.path}</bdi>
    </span>
  )
}
