// The session-ui pieces the review tab draws with (03 §15.1, §18.5), described by the props own-web passes. Only
// src/adapter may use @opencode/session-ui (03 §16.1, boundaries.test.ts), so the adapter composes the tab: it takes
// SessionReviewV2 (./v2/session-review-v2), SessionReviewFilePreviewV2 (./v2/session-review-file-preview-v2),
// SessionReviewEmptyChangesV2 (./v2/session-review-empty-changes-v2) and File (./file) and exports
// `createReviewTab({ Frame, Preview, EmptyChanges, File })` from ./panel as its default. The reference composition is
// e2e/review/kit.tsx (the e2e harness mounts exactly that).
//
// Assigning the session-ui components to these props types is where upstream prop changes surface as type errors.
import type { FileDiffInfo } from "@opencode/client"
import type { Component, JSX, ValidComponent } from "solid-js"
import type { DiffStyle, ExpandMode } from "./model"

/** session-ui `SessionReviewV2` (./v2/session-review-v2): toolbar (file position, ← →, expand) around the preview. */
export interface ReviewFrameProps {
  readonly files: string[]
  readonly activeFile?: string
  readonly onSelectFile: (file: string) => void
  readonly diffStyle: DiffStyle
  readonly expandMode: ExpandMode
  readonly onExpandModeChange: (mode: ExpandMode) => void
  readonly hasDiffs: boolean
  readonly sidebarOpen?: boolean
  readonly empty?: JSX.Element
  readonly preview?: JSX.Element
}

/** pierre's `SelectedLineRange`: lines of the diff side the selection started and ended on. */
export interface ReviewLineRange {
  start: number
  end: number
  side?: "additions" | "deletions"
  endSide?: "additions" | "deletions"
}

/** A line comment as the preview draws it (session-ui `SessionReviewComment`). */
export interface ReviewPreviewComment {
  id: string
  file: string
  selection: ReviewLineRange
  comment: string
}

/**
 * session-ui `SessionReviewFilePreviewV2` (./v2/session-review-file-preview-v2): header + pierre diff of one file,
 * with the line comment layer (./v2/line-comment-annotations-v2: select lines → comment editor → comment cards,
 * `⋯` edit/delete) when `onLineComment` is given (03 §19.1).
 */
export interface ReviewPreviewProps {
  readonly file: string
  readonly diff: FileDiffInfo
  readonly diffStyle: DiffStyle
  readonly expandMode?: ExpandMode
  readonly onLineComment?: (comment: {
    file: string
    selection: ReviewLineRange
    comment: string
    preview?: string
  }) => void
  readonly onLineCommentUpdate?: (comment: {
    id: string
    file: string
    selection: ReviewLineRange
    comment: string
    preview?: string
  }) => void
  readonly onLineCommentDelete?: (comment: { id: string; file: string }) => void
  readonly lineCommentActions?: { moreLabel: string; editLabel: string; deleteLabel: string; saveLabel: string }
  /** Mutable array type: the session-ui prop is `SessionReviewComment[]`. */
  readonly comments?: ReviewPreviewComment[]
  readonly focusedComment?: { file: string; id: string } | null
  readonly onFocusedCommentChange?: (focus: { file: string; id: string } | null) => void
}

export interface ReviewKit {
  readonly Frame: Component<ReviewFrameProps>
  readonly Preview: Component<ReviewPreviewProps>
  /** session-ui `SessionReviewEmptyChangesV2`. */
  readonly EmptyChanges: Component
  /** session-ui `File` (pierre viewer; its diff/highlight work runs in the pierre worker pool, 20.2 R4). */
  readonly File: ValidComponent
}
