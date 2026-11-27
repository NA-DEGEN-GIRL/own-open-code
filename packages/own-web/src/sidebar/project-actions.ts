// `프로젝트 보관` / `프로젝트 복원` (03 §19.11a) with their toasts: the project `⋯` runs them at once when no team is on,
// the project dialog once own.team answered. The toast after archiving offers `보관 취소`, which restores the same
// project. The row that started it may be gone by then (its sessions left the list), so nothing here holds UI.
import type { ServerRuntime } from "@/data"
import { showToast } from "@/switcher/toast"
import { sessionFlags } from "./flags"
import { archiveProject } from "./manage"
import type { SidebarText } from "./strings"

export async function runProjectArchive(
  runtime: ServerRuntime,
  project: { readonly projectID: string; readonly name: string },
  on: boolean,
  text: SidebarText,
) {
  const flags = sessionFlags(runtime.key)
  if (!flags) return
  const name = project.name
  const result = await archiveProject(runtime.client(), flags, project.projectID, on).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error)
    showToast({ message: text("own.sidebar.project.listFailed", { name, reason }), tone: "danger" })
    return undefined
  })
  if (!result) return
  if (!result.total) return void showToast({ message: text("own.sidebar.project.nothing", { name }) })
  const failed = result.failed.length
  if (failed)
    showToast({
      message: text(on ? "own.sidebar.project.archiveFailed" : "own.sidebar.project.restoreFailed", {
        name,
        n: failed,
      }),
      tone: "danger",
    })
  const done = result.total - failed
  if (!done) return
  if (!on) return void showToast({ message: text("own.sidebar.project.restored", { name, n: done }) })
  showToast({
    message: text("own.sidebar.project.archived", { name, n: done }),
    action: {
      label: text("own.sidebar.archivedUndo"),
      run: () => void runProjectArchive(runtime, project, false, text),
    },
  })
}
