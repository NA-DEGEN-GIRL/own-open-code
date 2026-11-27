// Opens the session delete confirmation (03 §19.11a) from anywhere (the row `⋯`, the header `⋯`, the palette, the
// archive's selection bar) and the project dialogs (`프로젝트 목록에서 삭제…`, a `프로젝트 보관` that a team blocks)
// without the caller holding UI: request signals plus one `<SessionDeleteHost>` mounted by the shell, which loads a
// dialog chunk only when a request arrives (03 §20.2 R5: every new dialog is lazy). A project row unmounts once its
// sessions are gone, so its dialogs cannot live in the row.
import { createRoot, createSignal, lazy, Show, Suspense } from "solid-js"
import type { ServerKey } from "@/data"

export interface DeleteRequest {
  readonly serverKey: ServerKey
  /** Root sessions with the titles the caller shows. */
  readonly sessions: readonly { readonly id: string; readonly title: string }[]
  /** `보관함 비우기`: the words of emptying the archive. */
  readonly emptyArchive?: boolean
  /** From the archive: delete only what the server still has archived (manage.ts `deleteSessions`). */
  readonly archivedOnly?: boolean
  /** After the deletes settled, with the ids that are gone (the archive's selection forgets them). */
  readonly onDone?: (deleted: readonly string[]) => void
}

export interface ProjectRequest {
  readonly serverKey: ServerKey
  readonly projectID: string
  readonly name: string
  readonly directory?: string
  readonly git: boolean
  /** `delete`: `프로젝트 목록에서 삭제…`. `archive`: a `프로젝트 보관` that waits for, or is blocked by, team mode. */
  readonly mode: "delete" | "archive"
}

const request = createRoot(() => {
  const [value, set] = createSignal<DeleteRequest>()
  const [project, setProject] = createSignal<ProjectRequest>()
  return { value, set, project, setProject }
})

export function openSessionDelete(next: DeleteRequest) {
  if (next.sessions.length) request.set(next)
}

export function openProjectManage(next: ProjectRequest) {
  request.setProject(next)
}

const Dialog = lazy(() => import("./manage-dialog"))
const ProjectDialog = lazy(() => import("./project-dialog"))

/** Mount once (shell). Renders nothing until a delete or a project dialog is requested. */
export function SessionDeleteHost() {
  return (
    <>
      <Show when={request.value()} keyed>
        {(current) => (
          <Suspense>
            <Dialog request={current} onClose={() => request.set(undefined)} />
          </Suspense>
        )}
      </Show>
      <Show when={request.project()} keyed>
        {(current) => (
          <Suspense>
            <ProjectDialog request={current} onClose={() => request.setProject(undefined)} />
          </Suspense>
        )}
      </Show>
    </>
  )
}
