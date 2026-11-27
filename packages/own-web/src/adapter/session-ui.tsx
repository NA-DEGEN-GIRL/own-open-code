// The only module that imports @opencode/session-ui (03 §16.1, enforced by boundaries.test.ts). Upstream changes to
// the session-ui surface show up here as type errors. Loaded only from the lazy transcript chunk (03 §20.2 R5), so
// nothing in this file may be imported by first-chunk code except through `import type`.
import { DataProvider } from "@opencode/session-ui/context"
import { MarkdownProvider } from "@opencode/session-ui/context/markdown"
import { createReactiveTimelineProjection } from "@opencode/session-ui/timeline/projection"
import { DialogProvider } from "@opencode/ui/context/dialog"
import { FileComponentProvider } from "@opencode/ui/context/file"
import { I18nProvider } from "@opencode/ui/context/i18n"
import { lazy, type Accessor, type ComponentProps, type ParentProps } from "solid-js"
import { imageSrc } from "@/image/object-url"
import { uiI18nSource } from "./ui-i18n"

export { createReactiveTimelineProjection }
export { Timeline, TimelineRow, type PartRef, type ReasoningMode } from "@opencode/session-ui/timeline/projection"
export { createSessionTimelineRowRenderer } from "@opencode/session-ui/timeline/row"
export { timelinePresets, type TimelineDetail } from "@opencode/session-ui/timeline/detail"
export { getReadyMarkdown, preloadMarkdown } from "@opencode/session-ui/markdown-cache"
export { SessionProgressIndicatorV2 } from "@opencode/session-ui/v2/session-progress-indicator-v2"

export type SessionUiData = ComponentProps<typeof DataProvider>["data"]
export type Projection = ReturnType<typeof createReactiveTimelineProjection>

// Diff/file viewers (pierre, shiki) load on first use, like upstream `shell/routes/routes.tsx` File.
const File = lazy(() => import("@opencode/session-ui/file").then((module) => ({ default: module.File })))

/** Session-independent context of session-ui rows: ui strings in the own locale, dialogs, the lazy file viewer. */
export function SessionUiShell(props: ParentProps<{ readonly locale: Accessor<"ko" | "en"> }>) {
  return (
    <I18nProvider value={uiI18nSource(props.locale)}>
      <DialogProvider>
        <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
      </DialogProvider>
    </I18nProvider>
  )
}

/**
 * Per-session session-ui data (provider names, child sessions, shells) and markdown hooks: `openLocalFile` makes the
 * answer's local file links open in the files tab (19.4); `openSession` turns a complete `ses_…` id in an answer into
 * a link to that session (upstream ffa4c4c730). A user's attached image shows as a `blob:` URL (`imageSrc`, core
 * P-057).
 */
export function SessionUiData(
  props: ParentProps<
    Omit<ComponentProps<typeof DataProvider>, "children"> & {
      readonly openLocalFile?: (path: string) => void
      readonly openSession?: (sessionID: string) => void
    }
  >,
) {
  return (
    <DataProvider
      data={props.data}
      directory={props.directory}
      sessionID={props.sessionID}
      shellRunning={props.shellRunning}
      shellOutput={props.shellOutput}
      onNavigateToSession={props.onNavigateToSession}
      onSessionHref={props.onSessionHref}
      peekMedia={imageSrc}
    >
      <MarkdownProvider openLocalFile={props.openLocalFile} openSession={props.openSession}>
        {props.children}
      </MarkdownProvider>
    </DataProvider>
  )
}
