import { createContext, useContext } from "solid-js"
import type { SidebarController } from "./controller"

export const SidebarContext = createContext<SidebarController>()

export function useSidebar() {
  const value = useContext(SidebarContext)
  if (!value) throw new Error("useSidebar() needs <SidebarContext.Provider>")
  return value
}
