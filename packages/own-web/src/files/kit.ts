// The session-ui pieces the files tab draws with (03 §15.1, §19.4), described by the props own-web passes. Only
// src/adapter may use @opencode/session-ui (03 §16.1, boundaries.test.ts), so the adapter composes the tab: it takes
//   File             ./file                      code view: pierre highlighting in its worker pool, the in-file find
//                                                 bar (./file-search) and ./file-media inside; virtualized > 500 KB
//   Markdown         ./markdown                  preview of .md (worker parse) and of mermaid sources (fenced block)
//   MarkdownProvider ./context/markdown          relative images and links of a previewed document
//   Frame            ./v2/session-file-panel-v2  tree sidebar + toolbar + viewer layout
// and exports `createFilesTab(kit)` from ./panel as its default. The reference composition is e2e/files/kit.tsx (the
// e2e harness mounts exactly that). Assigning the session-ui components to these props types is where upstream prop
// changes surface as type errors.
import type { Component, JSX, ParentProps } from "solid-js"

/** A range of 1-based lines (pierre `SelectedLineRange`). */
export interface LineRange {
  readonly start: number
  readonly end: number
}

/** session-ui `File` in text mode (its `FileProps` with `mode: "text"`). */
export interface CodeViewProps {
  readonly mode: "text"
  readonly file: { readonly name: string; readonly contents: string; readonly cacheKey?: string }
  /** Always off: media kinds have their own viewers here (as in upstream `file-tabs.tsx`). */
  readonly media: { readonly mode: "off" }
  /** Ctrl+F inside the viewer focuses the session-ui find bar (`FileSearchBar`). */
  readonly search?: { readonly register: (handle: { readonly focus: () => void } | null) => void }
  readonly selectedLines?: LineRange | null
  readonly enableLineSelection?: boolean
  readonly onRendered?: () => void
  readonly overflow?: "scroll" | "wrap"
  readonly class?: string
}

/** session-ui `Markdown`. */
export interface MarkdownViewProps {
  readonly text: string
  readonly cacheKey?: string
  readonly class?: string
}

/** session-ui `MarkdownProvider`: images and links of a previewed document resolve against its folder. */
export interface MarkdownContextProps extends ParentProps {
  readonly readImage?: (path: string, signal: AbortSignal) => Promise<Blob | undefined>
  readonly openLocalFile?: (path: string) => void
}

/** session-ui `SessionFilePanelV2`. */
export interface FrameProps {
  readonly sidebar?: JSX.Element
  readonly toolbar: boolean
  readonly toolbarStart?: JSX.Element
  readonly toolbarEnd?: JSX.Element
  readonly children?: JSX.Element
}

export interface FilesKit {
  readonly File: Component<CodeViewProps>
  readonly Markdown: Component<MarkdownViewProps>
  readonly MarkdownProvider: Component<MarkdownContextProps>
  readonly Frame: Component<FrameProps>
}
