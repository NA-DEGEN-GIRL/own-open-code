// Work panel `터미널` tab (03 §4.7, §18.6): its own lazy chunk (20.2 R5). The shell loads it on first open
// (`shell/work-panel.tsx` LOADERS.terminal) and keeps it mounted while hidden; `visible()` stops drawing then.
// ghostty-web is a further chunk loaded by the first terminal view, so the tab row paints before the wasm is ready.
import { useShell } from "@/shell/context"
import type { PanelTabProps } from "@/shell/work-panel"
import { TerminalPanel } from "./panel"

export default function TerminalTab(props: PanelTabProps) {
  const shell = useShell()
  return (
    <TerminalPanel
      serverKey={props.serverKey}
      sessionID={props.sessionID}
      visible={props.visible}
      placement="tab"
      reveal={() => shell.openTab("terminal")}
    />
  )
}
