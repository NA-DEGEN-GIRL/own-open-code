// What the first chunk knows of the lazy ./reorder.ts (moving and pinning projects, moving server sections): the menu
// items it adds once it is there, and what is folded while something is dragged.
import { createSignal } from "solid-js"
import type { MenuItem } from "@/servers/menu"
import type { SidebarController } from "./controller"

export interface ReorderApi {
  readonly projectItems: (ctl: SidebarController, projectID: string, name: string) => readonly MenuItem[]
  readonly serverItems: (key: string) => readonly MenuItem[]
}

export const [reorder, setReorder] = createSignal<ReorderApi>()

/**
 * While a project is dragged its server's projects show as headers only, and while a server section is dragged every
 * section does, so each place to drop is near: the server key, or `*` for the sections.
 */
export const [folding, setFolding] = createSignal<string>()
