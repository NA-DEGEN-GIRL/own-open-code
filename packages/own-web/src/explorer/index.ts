// `탐색기에서 열기` (03 §19.5, 05 §7.10) in the first chunk: only this signal. The entries (the conversation `⋯`, the
// project `⋯`, the command palette) and every string come with the lazy chunk ./actions, which the shell asks for once
// where the host can open Explorer (`host.explorer`: the desktop app). In a browser, on the phone and in a 원격 PC
// window nothing loads and the signal stays empty, so those items never show.
import { createSignal } from "solid-js"
import type { OwnHost } from "@/host"
import type { Router } from "@/routing/router"
import type { ExplorerEntries } from "./actions"

const [entries, setEntries] = createSignal<ExplorerEntries>()

export const explorerEntries = entries

/** The router takes a toast's `설정 열기` to 설정 > SSH 원격 호스트 (the lazy side names the route: PF5). */
export function prepareExplorer(host: OwnHost, router: Router) {
  const explorer = host.explorer
  if (!explorer || entries()) return
  void import("./actions").then((module) => setEntries(() => module.createExplorerEntries(explorer, router)))
}
