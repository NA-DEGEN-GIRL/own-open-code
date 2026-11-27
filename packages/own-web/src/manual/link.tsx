// A small `설명서: <chapter>` link that opens the in-app manual at that chapter (03 §4.3.1). Renders nothing in a
// build without the manual.
import { Show } from "solid-js"
import { useDiscoverText, type DiscoverKey } from "@/discover/strings"
import { Icon } from "@/shell/icons"
import { manualBase, openManual, type ManualPlace } from "./index"

/** Settings sections with a chapter of their own: every one (스킬 and MCP 서버 since SM, 2026-10-24). */
export const SECTION_CHAPTERS: Readonly<Record<string, { readonly place: ManualPlace; readonly label: DiscoverKey }>> =
  {
    general: { place: "settings", label: "own.discover.manual.settings" },
    layout: { place: "layout", label: "own.discover.manual.layout" },
    shortcuts: { place: "shortcuts", label: "own.discover.manual.shortcuts" },
    voice: { place: "voice", label: "own.discover.manual.voice" },
    desktop: { place: "desktop", label: "own.discover.manual.desktop" },
    presets: { place: "presets", label: "own.discover.manual.presets" },
    policy: { place: "policy", label: "own.discover.manual.policy" },
    compaction: { place: "compaction", label: "own.discover.manual.compaction" },
    output: { place: "output", label: "own.discover.manual.output" },
    approval: { place: "approval", label: "own.discover.manual.approval" },
    websearch: { place: "websearch", label: "own.discover.manual.websearch" },
    image: { place: "image", label: "own.discover.manual.image" },
    harness: { place: "prompts", label: "own.discover.manual.prompts" },
    skills: { place: "skills", label: "own.discover.manual.skills" },
    mcp: { place: "mcp", label: "own.discover.manual.mcp" },
    team: { place: "teamSettings", label: "own.discover.manual.team" },
    shell: { place: "shell", label: "own.discover.manual.shell" },
    experimental: { place: "experimental", label: "own.discover.manual.experimental" },
    devices: { place: "devices", label: "own.discover.manual.devices" },
    remote: { place: "remote", label: "own.discover.manual.remote" },
    github: { place: "github", label: "own.discover.manual.github" },
    server: { place: "server", label: "own.discover.manual.server" },
    plugins: { place: "plugins", label: "own.discover.manual.plugins" },
    creator: { place: "creator", label: "own.discover.manual.creator" },
    import: { place: "import", label: "own.discover.manual.import" },
    updates: { place: "updates", label: "own.discover.manual.updates" },
  }

export function ManualLink(props: {
  readonly place: ManualPlace
  readonly label: DiscoverKey
  readonly class?: string
}) {
  const text = useDiscoverText()
  return (
    <Show when={manualBase()}>
      <button
        type="button"
        class={`own-target inline-flex items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[12px] text-own-accent-text hover:bg-own-hover [&_svg]:size-3.5 [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:stroke-[1.6] ${props.class ?? ""}`}
        data-testid="manual-link"
        data-place={props.place}
        onClick={() => openManual(props.place)}
      >
        <Icon name="help" />
        {text("own.discover.manual.chapter", { chapter: text(props.label) })}
      </button>
    </Show>
  )
}

/** The settings page's link to its chapter, where it has one. */
export function SettingsManualLink(props: { readonly section: string }) {
  return (
    <Show when={SECTION_CHAPTERS[props.section]}>
      {(chapter) => <ManualLink place={chapter().place} label={chapter().label} class="-mt-2 mb-2" />}
    </Show>
  )
}
