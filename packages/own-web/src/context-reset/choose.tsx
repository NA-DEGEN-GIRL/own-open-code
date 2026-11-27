// `/undo` right after a reset (03 §18.7, §18.18): a revert to the last turn would also delete the marker, so the user
// picks `문맥 비우기 되돌리기` or `마지막 턴 복원`. Mounted on its own root from the lazy chunk, so the shell carries no
// layer for it (PF5).
import { render } from "solid-js/web"
import { I18nProvider, type Locale } from "@/i18n"
import { Dialog } from "@/limits/kit"
import { resetText } from "./strings"

export function chooseUndo(input: {
  readonly locale: Locale
  readonly undoReset: () => void
  readonly restoreTurn: () => void
}) {
  const words = (key: Parameters<typeof resetText.text>[1]) => resetText.text(input.locale, key)
  const host = document.createElement("div")
  document.body.append(host)
  const close = () => {
    dispose()
    host.remove()
  }
  const pick = (run: () => void) => () => {
    close()
    run()
  }
  const dispose = render(
    () => (
      <I18nProvider>
        <Dialog
          open
          title={words("own.reset.undoWhich")}
          onClose={close}
          dismissable
          testid="reset-undo-choice"
          footer={
            <>
              <button type="button" class="own-btn" data-testid="reset-undo-turn" onClick={pick(input.restoreTurn)}>
                {words("own.reset.undoTurn")}
              </button>
              <button
                type="button"
                class="own-btn"
                data-variant="primary"
                data-testid="reset-undo-reset"
                onClick={pick(input.undoReset)}
              >
                {words("own.reset.menuUndo")}
              </button>
            </>
          }
        >
          <p class="m-0">{words("own.reset.markerTitle")}</p>
        </Dialog>
      </I18nProvider>
    ),
    host,
  )
}
