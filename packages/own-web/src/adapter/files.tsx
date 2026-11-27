// The files tab's session-ui composition (03 §19.4, 4.7 `파일`): the work panel's lazy loader for the tab
// (`shell/work-panel.tsx` LOADERS.files). Only src/adapter may import @opencode/session-ui (03 §16.1), so the files
// module takes the session-ui components as arguments (src/files/kit.ts) and this file supplies them. Same content as
// e2e/files/kit.tsx, which the files e2e harness mounts. The code and markdown viewers are further lazy chunks: the
// tree paints before pierre and the markdown pipeline load.
import { MarkdownProvider } from "@opencode/session-ui/context/markdown"
import { SessionFilePanelV2 } from "@opencode/session-ui/v2/session-file-panel-v2"
import { lazy } from "solid-js"
import { createFilesTab } from "@/files/panel"

const File = lazy(() => import("@opencode/session-ui/file").then((module) => ({ default: module.File })))
const Markdown = lazy(() => import("@opencode/session-ui/markdown").then((module) => ({ default: module.Markdown })))

export default createFilesTab({ File, Markdown, MarkdownProvider, Frame: SessionFilePanelV2 })
