// 앱 종료 / 완전 종료 in the app (05 §7.3, desktop only: `capabilities.appQuit`). The shell owns the tray, the window's X
// and 완전 종료's dialog (it names what stops and offers 앱만 종료); these only ask for them:
//   - `QuitButtons`: the server status popover (sidebar `이 PC`) and 설정 > 데스크톱 앱;
//   - `useQuitCommands`: the palette's `앱 종료` and `완전 종료…`, and Ctrl+Q (`app.quitAll`), which opens the same dialog.
import { Show } from "solid-js"
import { useHost } from "@/host"
import type { HostApp } from "@/host/types"
import { useI18n, type Locale } from "@/i18n"
import { useShortcut } from "@/keyboard"
import { usePaletteCommands, type PaletteCommand } from "@/palette"
import { appQuitText, useAppQuitText, type AppQuitKey } from "./strings"

export { useAppQuitText } from "./strings"

const WORDS = {
  app: ["quit", "exit", "close", "끄기", "닫기", "종료", "앱 끄기"],
  all: ["quit", "exit", "stop service", "shut down", "끄기", "종료", "서비스 끄기", "서비스 종료", "전부 끄기"],
}

/** `buttonClass`: the popover's plain buttons instead of the settings page's `own-btn`. */
export function QuitButtons(props: { readonly class?: string; readonly buttonClass?: string }) {
  const host = useHost()
  const text = useAppQuitText()
  return (
    <Show when={host.app}>
      {(app) => (
        <div class={props.class ?? "flex flex-wrap gap-2"} data-testid="quit-buttons">
          <button
            type="button"
            class={props.buttonClass ?? "own-btn"}
            data-size={props.buttonClass ? undefined : "sm"}
            title={text("own.quit.app.hint")}
            data-testid="quit-app"
            onClick={() => void app().quit("app")}
          >
            {text("own.quit.app")}
          </button>
          <button
            type="button"
            class={props.buttonClass ?? "own-btn"}
            data-size={props.buttonClass ? undefined : "sm"}
            title={text("own.quit.all.hint")}
            data-testid="quit-all"
            onClick={() => void app().quit("all")}
          >
            {text("own.quit.all")}
          </button>
        </div>
      )}
    </Show>
  )
}

/** For a component the shell mounts once (shell/palette-commands.tsx). Nothing without the desktop shell's quit. */
export function useQuitCommands() {
  const host = useHost()
  const i18n = useI18n()
  const app = host.app
  if (!app) return
  useShortcut("app.quitAll", () => void app.quit("all"))
  usePaletteCommands(() => quitCommands(app, i18n.locale()))
}

/** The palette's `앱` group: 앱 종료 and 완전 종료…, with the other language and the words people type. */
export function quitCommands(app: HostApp, locale: Locale): PaletteCommand[] {
  const other = locale === "ko" ? "en" : "ko"
  const label = (key: AppQuitKey, words: readonly string[]) => ({
    title: appQuitText.text(locale, key),
    keywords: [appQuitText.text(other, key), ...words],
  })
  return [
    {
      id: "app.quit",
      group: "app",
      ...label("own.quit.app", WORDS.app),
      detail: appQuitText.text(locale, "own.quit.app.detail"),
      run: () => void app.quit("app"),
    },
    {
      id: "app.quitAll",
      group: "app",
      ...label("own.quit.all", WORDS.all),
      detail: appQuitText.text(locale, "own.quit.all.detail"),
      shortcut: "app.quitAll",
      run: () => void app.quit("all"),
    },
  ]
}
