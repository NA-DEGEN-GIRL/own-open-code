// Provider order (03 §16.1): Host → Theme → I18n → [Dialog → FileComponent → Data(session-ui) → Markdown, added by
// the transcript owner through src/adapter] → own Data (servers, OwnStore) → Router → Shortcuts → Shell.
import { ThemeProvider } from "@opencode/ui/theme/context"
import type { ParentProps } from "solid-js"
import { createDataLayer, DataProvider, type DataLayer } from "@/data"
import { HostProvider, routerMode, windowKey, type OwnHost } from "@/host"
import { createI18n, I18nProvider, type I18n } from "@/i18n"
import { ShortcutProvider } from "@/keyboard"
import { createRebindableRegistry } from "@/palette"
import { markOnce } from "@/perf/marks"
import { createMemoryRouter, createPathRouter, RouterProvider, type Router } from "@/routing/router"
import { AppShell } from "@/shell/app-shell"
import { createShell, ShellProvider } from "@/shell/context"
import { seedColorScheme, windowBackground } from "@/shell/theme-default"

export interface AppProps {
  readonly host: OwnHost
  /** Tests inject these; production creates them. */
  readonly i18n?: I18n
  readonly data?: DataLayer
  readonly router?: Router
}

export function App(props: AppProps) {
  const host = props.host
  const i18n = props.i18n ?? createI18n()
  const key = windowKey(host)
  const router =
    props.router ?? (routerMode(host) === "memory" ? createMemoryRouter(`own.web.route.${key}`) : createPathRouter())
  const data = props.data ?? createDataLayer({ host })
  // Dark by default: the provider reads the stored scheme when it starts, so the seed goes first (theme-default.ts).
  seedColorScheme()
  let firstTheme = true
  return (
    <HostProvider value={host}>
      <ThemeProvider
        onThemeApplied={(mode, scheme) => {
          // T0-4 on every theme change; T0-3 once, right after the first themed paint (05 §6.3).
          host.setChrome({ mode, scheme, background: background(mode) })
          if (!firstTheme) return
          firstTheme = false
          requestAnimationFrame(() => {
            host.ready()
            markOnce("own:first-paint")
          })
        }}
      >
        <I18nProvider value={i18n}>
          <DataProvider value={data}>
            <RouterProvider value={router}>
              {/* The user keymap (03 §10 rebinding, 설정 > 단축키) applies without a reload: palette/rebindable.ts. */}
              <ShortcutProvider value={createRebindableRegistry()}>
                <Shell windowKey={key} />
              </ShortcutProvider>
            </RouterProvider>
          </DataProvider>
        </I18nProvider>
      </ThemeProvider>
    </HostProvider>
  )
}

function Shell(props: ParentProps<{ readonly windowKey: string }>) {
  return (
    <ShellProvider value={createShell({ windowKey: props.windowKey })}>
      <AppShell />
    </ShellProvider>
  )
}

/** Window background = --own-bg-subtle (03 §13.1), read after the theme CSS applied, as `#rrggbb` (theme-default.ts). */
function background(mode: "light" | "dark") {
  return windowBackground(getComputedStyle(document.documentElement).getPropertyValue("--own-bg-subtle"), mode)
}
