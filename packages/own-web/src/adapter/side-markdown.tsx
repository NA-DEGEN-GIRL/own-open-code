// The side panel's answer view (곁질문, 03 §4.4.2): session-ui's Markdown, the transcript's renderer with its streaming
// path, so an answer reads like an assistant message. It needs the transcript's session-ui shell (ui strings in the
// own locale) and a markdown context. Only src/adapter may import @opencode/session-ui (03 §16.1).
import { MarkdownProvider } from "@opencode/session-ui/context/markdown"
import { Markdown } from "@opencode/session-ui/markdown"
import { useI18n } from "@/i18n"
import { SessionUiShell } from "./session-ui"

export default function SideMarkdown(props: { readonly text: string; readonly cacheKey: string; readonly streaming: boolean }) {
  const i18n = useI18n()
  return (
    <SessionUiShell locale={i18n.locale}>
      <MarkdownProvider>
        <Markdown text={props.text} cacheKey={props.cacheKey} streaming={props.streaming} />
      </MarkdownProvider>
    </SessionUiShell>
  )
}
