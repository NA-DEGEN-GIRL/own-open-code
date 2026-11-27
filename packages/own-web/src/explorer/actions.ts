// `탐색기에서 열기` / `탐색기에서 보기` (03 §19.5, 05 §7.10), the lazy part: what a click does and the entries of the
// conversation `⋯`, the project `⋯` and the command palette. Loaded only where `host.explorer` exists (./index.ts).
//  - A folder or file of this PC goes to `host.explorer.reveal`: the desktop app checks that it is inside an open
//    folder, opens a folder in Explorer and shows a file selected in its folder.
//  - One on an SSH host goes to `host.explorer.launch` with the host's SSH target: the desktop app starts the program
//    of 설정 > SSH 원격 호스트. With no program chosen the click explains that and offers the setting.
// Nothing here runs without a click, and a failure is always a toast that says why.
import type { ServerKey, ServerRuntime } from "@/data"
import type { ExplorerResult, HostExplorer } from "@/host/types"
import type { Locale } from "@/i18n"
import type { PaletteCommand } from "@/palette"
import type { Router } from "@/routing/router"
import { remoteStore } from "@/servers/active"
import type { MenuItem } from "@/servers/menu"
import { showToast, type ToastInput } from "@/switcher/toast"
import { explorerText, type ExplorerKey } from "./strings"

export interface ExplorerPlace {
  /** The conversation runs on an SSH host: `path` is a path there. */
  readonly ssh: boolean
  readonly serverKey: ServerKey
  /** Absolute: a native path of this PC, or a POSIX path on the host. */
  readonly path: string
}

type Runtime = Pick<ServerRuntime, "kind">

/**
 * `{host}` of the program's arguments: what own gives ssh for this host. A host picked from the ssh config is its
 * alias; one typed by hand is the last word of the typed line (`ssh -p 2222 dev@box` → `dev@box`), the destination
 * own-remote's parser passes to ssh. Options typed before it (port, jump host) are not part of it.
 */
export function sshTarget(target: string) {
  return target.trim().split(/\s+/).at(-1) ?? ""
}

/** Failures whose toast offers 설정: the fix is there. */
const IN_SETTINGS: ReadonlySet<string> = new Set(["unconfigured", "program", "template"])

export function createExplorerEntries(
  explorer: HostExplorer,
  router: Pick<Router, "navigate">,
  toast: (input: ToastInput) => unknown = showToast,
) {
  /** 설정 > SSH 원격 호스트, where the program is chosen (./settings.tsx). */
  const settings = () => router.navigate({ name: "settings", section: "remote" })
  const report = (result: ExplorerResult, place: ExplorerPlace, locale: Locale) => {
    if (result.ok) return
    toast({
      message: explorerText.text(locale, `own.explorer.fail.${result.reason}` as ExplorerKey, {
        path: place.path,
        detail: result.detail || place.path,
      }),
      // No program yet is a step to take, not an error.
      tone: result.reason === "unconfigured" ? "neutral" : "danger",
      action: IN_SETTINGS.has(result.reason)
        ? { label: explorerText.text(locale, "own.explorer.openSettings"), run: settings }
        : undefined,
    })
  }
  const open = async (place: ExplorerPlace, locale: Locale) => {
    const target = place.ssh ? remoteStore()?.host(place.serverKey)?.target : undefined
    // The host list has not arrived (or the host was removed while its conversation stayed open).
    if (place.ssh && !target)
      return void toast({ message: explorerText.text(locale, "own.explorer.fail.noHost"), tone: "danger" })
    const result = await (
      target ? explorer.launch({ host: sshTarget(target), path: place.path }) : explorer.reveal(place.path)
    ).catch(
      (error: unknown): ExplorerResult => ({
        ok: false,
        reason: "failed",
        detail: error instanceof Error ? error.message : String(error),
      }),
    )
    report(result, place, locale)
  }
  const place = (runtime: Runtime, serverKey: ServerKey, path: string): ExplorerPlace => ({
    ssh: runtime.kind === "ssh",
    serverKey,
    path,
  })
  // Positional arguments: the callers are in the first chunk, where every byte counts (PF5).
  const item = (
    testid: string,
    runtime: Runtime | undefined,
    serverKey: ServerKey,
    directory: string | undefined,
    locale: Locale,
  ): MenuItem[] => {
    if (!runtime || !directory) return []
    return [
      {
        label: explorerText.text(locale, "own.explorer.open"),
        onSelect: () => void open(place(runtime, serverKey, directory), locale),
        testid,
      },
    ]
  }
  return {
    /** Opens the place and reports a failure as a toast; never rejects. */
    open,
    /** Conversation `⋯`: the conversation's working folder (a worktree folder when it runs in one). */
    sessionItems: (runtime: Runtime | undefined, serverKey: ServerKey, directory: string | undefined, locale: Locale) =>
      item("session-menu-explorer", runtime, serverKey, directory, locale),
    /** Sidebar project `⋯`: the project's folder. */
    projectItems: (runtime: Runtime | undefined, serverKey: ServerKey, directory: string | undefined, locale: Locale) =>
      item("project-menu-explorer", runtime, serverKey, directory, locale),
    /** Command palette: the open conversation's working folder. */
    commands(
      runtime: Runtime | undefined,
      serverKey: ServerKey,
      directory: string | undefined,
      locale: Locale,
    ): PaletteCommand[] {
      if (!runtime || !directory) return []
      return [
        {
          id: "explorer.open",
          group: "project",
          title: explorerText.text(locale, "own.explorer.open"),
          detail: directory,
          keywords: [
            explorerText.text(locale === "ko" ? "en" : "ko", "own.explorer.open"),
            "explorer",
            "folder",
            "탐색기",
            "폴더",
          ],
          run: () => void open(place(runtime, serverKey, directory), locale),
        },
      ]
    },
  }
}

export type ExplorerEntries = ReturnType<typeof createExplorerEntries>
