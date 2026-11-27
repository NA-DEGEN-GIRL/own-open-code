// The header's settings button (03 §4.3.1, §4.4): on every screen and tier, so settings stay one click away when the
// sidebar is folded, a drawer, or the phone's list screen. Same place as Ctrl+, and the palette's `설정 열기`; on the
// settings page it closes them again, like the sidebar's 설정 (2026-10-18). Beside it, `?` opens the in-app user
// manual where the build has it.
import { Show } from "solid-js"
import { useI18n } from "@/i18n"
import { chordLabel, DEFAULT_KEYMAP } from "@/keyboard"
import { manualBase, openManual } from "@/manual"
import { useRouter } from "@/routing/router"
import { useShell } from "@/shell/context"
import { Icon } from "@/shell/icons"
import { useDiscoverText } from "./strings"

export function SettingsButton() {
  const router = useRouter()
  const shell = useShell()
  const i18n = useI18n()
  const text = useDiscoverText()
  const label = () =>
    text("own.discover.settings.open", { keys: chordLabel(DEFAULT_KEYMAP["settings.open"].chords[0]) })
  return (
    <>
      <button
        type="button"
        class="own-icon-button own-target"
        aria-label={i18n.t("own.nav.settings")}
        title={label()}
        aria-pressed={router.route().name === "settings"}
        data-testid="header-settings"
        onClick={() => shell.togglePage({ name: "settings", section: "general", list: true })}
      >
        <Icon name="gear" />
      </button>
      <Show when={manualBase()}>
        <button
          type="button"
          class="own-icon-button own-target"
          aria-label={text("own.discover.manual.open")}
          title={text("own.discover.manual.open")}
          data-testid="header-manual"
          onClick={() => openManual()}
        >
          <Icon name="help" />
        </button>
      </Show>
    </>
  )
}
