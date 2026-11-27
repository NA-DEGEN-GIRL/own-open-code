// Thread-note dialog (lazy, 03 §19.10): the editor in a modal until the session-info drawer (5.6) hosts it as its
// `노트` section. Esc and the close button keep an unsaved draft for the next time the editor opens.
import { Show } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { Dialog } from "@/limits/kit"
import { ThreadNotes } from "./panel"
import { useNotesText } from "./strings"

export default function NotesDialog(props: {
  readonly serverKey: ServerKey
  readonly sessionID: string
  readonly onClose: () => void
}) {
  const data = useData()
  const text = useNotesText()
  const runtime = () => data.get(props.serverKey)
  return (
    <Dialog open title={text("own.notes.dialogTitle")} onClose={props.onClose} testid="notes-dialog" dismissable>
      <Show when={runtime()} fallback={<p class="m-0 text-own-muted">{text("own.notes.noSession")}</p>}>
        {(current) => (
          <ThreadNotes runtime={current()} serverKey={props.serverKey} sessionID={props.sessionID} autofocus />
        )}
      </Show>
    </Dialog>
  )
}
