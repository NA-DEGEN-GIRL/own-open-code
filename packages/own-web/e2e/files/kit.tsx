// Reference composition of the files tab = the content of src/adapter/files.tsx (wiring request: the integrator
// copies this file there, and `LOADERS.files` in shell/work-panel.tsx becomes `() => import("@/adapter/files")`).
// Only src/adapter may import @opencode/session-ui (03 §16.1); the e2e harness mounts this exact module.
// The code and markdown viewers are further lazy chunks: the tree paints before pierre and the markdown pipeline load.
import { MarkdownProvider } from "@opencode/session-ui/context/markdown"
import { SessionFilePanelV2 } from "@opencode/session-ui/v2/session-file-panel-v2"
import { lazy } from "solid-js"
import { createFilesTab } from "@/files/panel"

const File = lazy(() => import("@opencode/session-ui/file").then((module) => ({ default: module.File })))
const Markdown = lazy(() => import("@opencode/session-ui/markdown").then((module) => ({ default: module.Markdown })))

export default createFilesTab({ File, Markdown, MarkdownProvider, Frame: SessionFilePanelV2 })
