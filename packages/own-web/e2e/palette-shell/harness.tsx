// Palette harness for Playwright (dev server only): the providers of src/app.tsx around the real AppShell, wired the
// way the integrator is asked to (report of the palette module):
//   - `<ShortcutProvider value={createRebindableRegistry()}>` so rebinding in 설정 > 단축키 applies at once,
//   - `<PaletteLayer />`, which the AppShell mounts once (P7 wiring).
// Query switches: `?page=shell|shortcuts` shows that settings page in a side sheet (the settings route itself belongs
// to the settings module until the integrator swaps its placeholders), `?source` registers an external command source
// like a feature module would (a fake "Git: 커밋…" row), `?light` starts in the light theme.
import "@/styles/index.css"
import { ThemeProvider } from "@opencode/ui/theme/context"
import { lazy, Show, Suspense } from "solid-js"
import { render } from "solid-js/web"
import { createDataLayer, DataProvider } from "@/data"
import { HostProvider, windowKey } from "@/host"
import { createWebHost } from "@/host/web"
import { createI18n, I18nProvider } from "@/i18n"
import { ShortcutProvider } from "@/keyboard"
import { createRebindableRegistry, usePaletteCommands } from "@/palette"
import { createMemoryRouter, RouterProvider } from "@/routing/router"
import { AppShell } from "@/shell/app-shell"
import { createShell, ShellProvider } from "@/shell/context"
import { seedColorScheme } from "@/shell/theme-default"

const ShellSettings = lazy(() => import("@/settings/shell"))
const ShortcutSettings = lazy(() => import("@/palette/shortcut-settings"))

const params = new URLSearchParams(location.search)
const host = createWebHost()
const page = params.get("page")
const ran: string[] = []

if (params.has("light")) localStorage.setItem("opencode-color-scheme", "light")
seedColorScheme()

render(() => {
  const data = createDataLayer({ host })
  const router = createMemoryRouter(`own.web.palette.harness.${Date.now()}`)
  const registry = createRebindableRegistry()
  Object.assign(window, { __paletteHarness: { runtime: data.local(), router, registry, ran } })
  return (
    <HostProvider value={host}>
      <ThemeProvider>
        <I18nProvider value={createI18n("ko")}>
          <DataProvider value={data}>
            <RouterProvider value={router}>
              <ShortcutProvider value={registry}>
                <ShellProvider value={createShell({ windowKey: windowKey(host) })}>
                  <AppShell />
                  <Show when={params.has("source")}>
                    <FeatureSource />
                  </Show>
                  <Show when={page}>
                    {/* Tailwind scans src/ only (styles/index.css), so the sheet places itself inline. */}
                    <section
                      class="border-l border-own-border bg-own-bg p-5 text-own-text"
                      style={{
                        position: "fixed",
                        top: 0,
                        bottom: 0,
                        right: 0,
                        "z-index": 50,
                        width: "min(760px, 100vw)",
                        "overflow-y": "auto",
                      }}
                      data-testid="harness-page"
                    >
                      <Suspense>
                        <Show when={page === "shell"} fallback={<ShortcutSettings />}>
                          <ShellSettings />
                        </Show>
                      </Suspense>
                    </section>
                  </Show>
                </ShellProvider>
              </ShortcutProvider>
            </RouterProvider>
          </DataProvider>
        </I18nProvider>
      </ThemeProvider>
    </HostProvider>
  )
}, document.getElementById("root")!)

/** What a feature module (git actions, 18) does to appear in the palette. */
function FeatureSource() {
  usePaletteCommands(() => [
    {
      id: "git.commit",
      title: "Git: 커밋…",
      group: "git",
      keywords: ["git commit"],
      run: () => void ran.push("git.commit"),
    },
  ])
  return null
}
