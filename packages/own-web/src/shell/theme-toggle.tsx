// Header theme toggle: dark → light → system (03 §5.7 General has the same choice, dark first as the default). Uses
// the @opencode/ui theme context, so custom ui themes keep working and the preload script reads the same storage keys.
import { useTheme } from "@opencode/ui/theme/context"
import { useI18n } from "@/i18n"
import { Icon } from "./icons"
import { nextColorScheme } from "./theme-default"

const ICON = { system: "system", light: "sun", dark: "moon" } as const

export function ThemeToggle() {
  const theme = useTheme()
  const i18n = useI18n()
  const scheme = () => theme.colorScheme()
  return (
    <button
      type="button"
      class="own-icon-button"
      data-testid="theme-toggle"
      data-scheme={scheme()}
      aria-label={i18n.t("own.shell.theme", { scheme: i18n.t(`own.shell.theme.${scheme()}`) })}
      title={i18n.t("own.shell.theme", { scheme: i18n.t(`own.shell.theme.${scheme()}`) })}
      onClick={() => theme.setColorScheme(nextColorScheme(scheme()))}
    >
      <Icon name={ICON[scheme()]} />
    </button>
  )
}
