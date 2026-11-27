// In-app user manual (03 §4.3.1). The page ships inside own-web's build (vite.ts), so it is offline and served by
// whatever serves this app: the desktop renderer, the remote-access gateway, the service's web fallback. It opens in
// a full-window viewer over the app (viewer.tsx, lazy), never in another program: a desktop window has no browser to
// hand an `oc://` page to. Chapters are anchors of the page (`#ch17-3`); `MANUAL` names the ones the app links to.
// Entry points: the header's `?` (beside the settings gear), 설정's `설명서`, the palette's `설명서 열기`, the first-run hints and the
// settings pages that have a chapter (every one), the 에이전트 방식 menu.
import { createSignal, lazy, Show, Suspense } from "solid-js"

const Viewer = lazy(() => import("./viewer"))

/** Chapters and sections the app links to (anchors of own/docs/manual/own-open-code-manual.html). */
export const MANUAL = {
  top: "",
  screen: "ch05-2",
  desktop: "ch05-7",
  settings: "ch05-9",
  approval: "ch08",
  websearch: "ch08-7",
  plugins: "ch08-8",
  shell: "ch09-5",
  palette: "ch10-6",
  voice: "ch10-10",
  image: "ch10-17",
  skills: "ch10-11",
  harness: "ch10-12",
  prompts: "ch10-13",
  mcp: "ch10-15",
  github: "ch28",
  creator: "ch29",
  policy: "ch12-6",
  compaction: "ch13",
  output: "ch05-9-1",
  presets: "ch14",
  team: "ch17",
  teamEnable: "ch17-3",
  teamSettings: "ch17-19",
  experimental: "ch18",
  layout: "ch19",
  import: "ch21",
  remote: "ch22",
  devices: "ch24",
  server: "ch26-2",
  shortcuts: "ch91",
  updates: "ch02-9",
} as const

export type ManualPlace = keyof typeof MANUAL

/** The manual page's path in this build, `undefined` when the build has none. */
export function manualBase() {
  return import.meta.env.OWN_MANUAL_URL || undefined
}

/** The page at a chapter: `base#anchor`, or the start of the page. */
export function manualHref(base: string, place: ManualPlace = "top") {
  const anchor = MANUAL[place]
  return anchor ? `${base}#${anchor}` : base
}

const [open, setOpen] = createSignal<readonly [href: string, chapter: string]>()

/**
 * Opens the manual at a chapter, or at an anchor inside it (the chapter when this build's page lacks the anchor);
 * does nothing in a build without it.
 */
export function openManual(place: ManualPlace = "top", anchor?: string) {
  const base = manualBase()
  if (base) setOpen([anchor ? `${base}#${anchor}` : manualHref(base, place), MANUAL[place]])
}

/** Mounted once by the shell: the viewer while the manual is open. */
export function ManualLayer() {
  return (
    <Show when={open()} keyed>
      {(at) => (
        <Suspense>
          <Viewer href={at[0]} chapter={at[1]} onClose={() => setOpen(undefined)} />
        </Suspense>
      )}
    </Show>
  )
}
