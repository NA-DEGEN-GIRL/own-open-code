// The viewer of one open file (03 §19.4 "뷰어(코드·Markdown·mermaid·이미지·PDF)"), after upstream `file-tabs.tsx` and
// `artifact-view.tsx`: code in session-ui `File` (pierre, highlighted in its worker pool, virtualized past 500 KB,
// Ctrl+F opens its find bar), Markdown and mermaid previews in session-ui `Markdown` with a 미리보기/원본 switch,
// images (fit / 1:1), PDFs in the browser's viewer, audio and video, and placeholders for everything else. A `:12`
// link highlights line 12 and scrolls it into view.
import { sampledChecksum } from "@opencode/util/encode"
import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Suspense,
  Switch,
  type JSX,
} from "solid-js"
import { useI18n } from "@/i18n"
import { isMedia, isPreviewable, MAX_MARKDOWN_PREVIEW, viewKind, type FileContent, type ViewKind } from "./content"
import type { FileEntry, FilesController } from "./controller"
import { FilesIcon } from "./icons"
import type { FilesKit } from "./kit"
import { basename, dirname, isAbsolute, locate } from "./paths"
import { formatBytes, useFilesText } from "./strings"
import type { FileTab } from "./tabs"
import { artifactMime } from "./upstream/artifact"

export type ViewMode = "preview" | "source"

/** Toolbar and body of the active tab, laid out by session-ui `SessionFilePanelV2` (kit.Frame). */
export function FileView(props: {
  readonly kit: FilesKit
  readonly controller: FilesController
  readonly tab: FileTab
  readonly sidebar?: JSX.Element
  readonly mode: ViewMode
  readonly onMode: (mode: ViewMode) => void
  readonly onMenu: (opener: HTMLElement) => void
}) {
  const text = useFilesText()
  const i18n = useI18n()
  const entry = () => props.controller.contents(props.tab.path)
  const ready = () => {
    const current = entry()
    return current?.status === "ready" ? current.content : undefined
  }
  const previewable = () => {
    const content = ready()
    return content?.type === "text" && isPreviewable(content.kind)
  }
  const [info, setInfo] = createSignal<string>()
  createEffect(
    on(
      () => props.tab.path,
      () => setInfo(undefined),
    ),
  )
  const meta = () =>
    [
      info(),
      ready() && ready()!.type !== "binary" ? formatBytes(i18n.locale(), ready()!.bytes) : undefined,
      props.tab.line ? text("own.files.line", { line: props.tab.line }) : undefined,
    ].filter((item): item is string => Boolean(item))
  const url = () => props.controller.editorUrl(props.tab.path, props.tab.line)
  const app = () => props.controller.actions().open?.kind === "app"

  return (
    <props.kit.Frame
      sidebar={props.sidebar}
      toolbar
      toolbarStart={
        <div class="own-files-title" data-testid="files-title">
          <span class="own-files-path" title={props.tab.path}>
            <bdi>
              <Show when={dirname(props.tab.path)}>
                <span class="own-files-dir">{dirname(props.tab.path)}/</span>
              </Show>
              <span class="own-files-file">{basename(props.tab.path)}</span>
            </bdi>
          </span>
          <Show when={meta().length > 0}>
            <span class="own-files-meta">{meta().join(" · ")}</span>
          </Show>
        </div>
      }
      toolbarEnd={
        <div class="own-files-actions">
          <Show when={previewable()}>
            <div
              class="own-files-seg"
              role="radiogroup"
              aria-label={text("own.files.viewMode")}
              data-testid="files-mode"
            >
              <button
                type="button"
                role="radio"
                aria-checked={props.mode === "preview"}
                onClick={() => props.onMode("preview")}
              >
                {text("own.files.preview")}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={props.mode === "source"}
                onClick={() => props.onMode("source")}
              >
                {text("own.files.source")}
              </button>
            </div>
          </Show>
          <Show when={app()}>
            <button
              type="button"
              class="own-icon-button"
              aria-label={text("own.files.openInEditor")}
              title={text("own.files.openInEditor")}
              data-testid="files-editor"
              onClick={() => void props.controller.openInEditor(props.tab.path)}
            >
              <FilesIcon name="editor" />
            </button>
          </Show>
          <Show when={!app() && url()}>
            {(href) => (
              <a
                class="own-icon-button"
                href={href()}
                aria-label={text("own.files.openInEditor")}
                title={text("own.files.openInEditor")}
                data-testid="files-editor"
              >
                <FilesIcon name="editor" />
              </a>
            )}
          </Show>
          <button
            type="button"
            class="own-icon-button"
            aria-label={text("own.files.more")}
            title={text("own.files.more")}
            aria-haspopup="menu"
            data-testid="files-more"
            onClick={(event) => props.onMenu(event.currentTarget)}
          >
            <FilesIcon name="more" />
          </button>
        </div>
      }
    >
      <div
        class="own-files-body"
        id="own-files-view"
        role="tabpanel"
        data-testid="files-viewer"
        data-status={entry()?.status}
      >
        {/* The code and markdown viewers are lazy (kit.tsx): their first load must not suspend the whole tab. */}
        <Suspense fallback={<p class="own-files-state">{text("own.files.loading")}</p>}>
          <Body
            kit={props.kit}
            controller={props.controller}
            tab={props.tab}
            entry={entry()}
            mode={props.mode}
            onInfo={setInfo}
          />
        </Suspense>
      </div>
    </props.kit.Frame>
  )
}

function Body(props: {
  readonly kit: FilesKit
  readonly controller: FilesController
  readonly tab: FileTab
  readonly entry: FileEntry | undefined
  readonly mode: ViewMode
  readonly onInfo: (info: string | undefined) => void
}) {
  const text = useFilesText()
  const i18n = useI18n()
  const path = () => props.tab.path
  const status = <S extends FileEntry["status"]>(value: S) => {
    const entry = props.entry
    return entry?.status === value ? (entry as Extract<FileEntry, { status: S }>) : undefined
  }
  return (
    <Switch fallback={<p class="own-files-state">{text("own.files.loading")}</p>}>
      <Match when={status("outside")}>
        <p class="own-files-state" data-testid="files-outside">
          {text("own.files.outside", { path: props.controller.absolute(path()) })}
        </p>
      </Match>
      <Match when={status("missing")}>
        <p class="own-files-state" data-testid="files-missing">
          {text("own.files.notFound", { path: path() })}
        </p>
      </Match>
      <Match when={status("error")}>
        {(entry) => (
          <div class="own-files-state">
            <p role="alert">{text("own.files.error", { message: entry().message })}</p>
            <button type="button" class="own-button" onClick={() => props.controller.ensure(path(), { force: true })}>
              {text("own.files.retry")}
            </button>
          </div>
        )}
      </Match>
      <Match when={status("direct")}>
        {(entry) => (
          <Media kind={viewKind(path())} src={entry().url} name={basename(path())} blob={false} onInfo={props.onInfo} />
        )}
      </Match>
      <Match when={status("ready")}>
        {(entry) => (
          <Content
            kit={props.kit}
            controller={props.controller}
            tab={props.tab}
            content={entry().content}
            mode={props.mode}
            onInfo={props.onInfo}
            size={formatBytes(i18n.locale(), entry().content.bytes)}
          />
        )}
      </Match>
    </Switch>
  )
}

function Content(props: {
  readonly kit: FilesKit
  readonly controller: FilesController
  readonly tab: FileTab
  readonly content: FileContent
  readonly mode: ViewMode
  readonly size: string
  readonly onInfo: (info: string | undefined) => void
}) {
  const text = useFilesText()
  const path = () => props.tab.path
  const type = <T extends FileContent["type"]>(value: T) =>
    props.content.type === value ? (props.content as Extract<FileContent, { type: T }>) : undefined
  return (
    <Switch>
      <Match when={type("binary")}>
        <div class="own-files-state" data-testid="files-binary">
          <FilesIcon name="file" class="own-files-state-icon" />
          <p>{text("own.files.binary", { size: props.size })}</p>
        </div>
      </Match>
      <Match when={type("large")}>
        {(large) => (
          <div class="own-files-state" data-testid="files-large">
            <p>{text("own.files.tooLarge", { size: props.size })}</p>
            <Show when={!isMedia(large().kind)}>
              <button type="button" class="own-button" onClick={() => props.controller.ensure(path(), { large: true })}>
                {text("own.files.showAnyway")}
              </button>
            </Show>
          </div>
        )}
      </Match>
      <Match when={type("media")}>
        {(media) => <BlobMedia content={media()} name={basename(path())} onInfo={props.onInfo} />}
      </Match>
      <Match when={type("text")}>
        {(file) => (
          <TextContent kit={props.kit} controller={props.controller} tab={props.tab} file={file()} mode={props.mode} />
        )}
      </Match>
    </Switch>
  )
}

function TextContent(props: {
  readonly kit: FilesKit
  readonly controller: FilesController
  readonly tab: FileTab
  readonly file: Extract<FileContent, { type: "text" }>
  readonly mode: ViewMode
}) {
  const text = useFilesText()
  const kind = () => props.file.kind
  const preview = () => props.mode === "preview" && isPreviewable(kind())
  const tooLarge = () => (kind() === "markdown" || kind() === "mermaid") && props.file.bytes > MAX_MARKDOWN_PREVIEW
  const code = () => (
    <CodeView
      kit={props.kit}
      path={props.tab.path}
      text={props.file.text}
      line={props.tab.line}
      jump={props.tab.jump}
    />
  )
  return (
    <Switch fallback={code()}>
      <Match when={preview() && tooLarge()}>
        <p class="own-files-note">{text("own.files.markdownTooLarge")}</p>
        {code()}
      </Match>
      <Match when={preview() && kind() === "svg"}>
        <SvgPreview text={props.file.text} name={basename(props.tab.path)} />
      </Match>
      <Match when={preview()}>
        <MarkdownView
          kit={props.kit}
          controller={props.controller}
          path={props.tab.path}
          text={kind() === "mermaid" ? `\`\`\`mermaid\n${props.file.text}\n\`\`\`` : props.file.text}
        />
      </Match>
    </Switch>
  )
}

/** Code with highlighting (session-ui `File`, pierre worker pool). Ctrl+F inside opens the in-file find bar. */
function CodeView(props: {
  readonly kit: FilesKit
  readonly path: string
  readonly text: string
  readonly line?: number
  readonly jump?: number
}) {
  const element = { scroller: undefined as HTMLDivElement | undefined }
  const find = { handle: null as { readonly focus: () => void } | null }
  const search = { register: (handle: { readonly focus: () => void } | null) => void (find.handle = handle) }
  const cacheKey = createMemo(() => `${props.path}:${sampledChecksum(props.text) ?? "empty"}`)
  const pending = { jump: true }
  createEffect(
    on(
      () => props.jump,
      () => (pending.jump = true),
      { defer: true },
    ),
  )
  const jump = () => {
    const line = props.line
    const scroller = element.scroller
    if (!pending.jump || !line || !scroller) return
    pending.jump = false
    const host = scroller.querySelector("diffs-container")
    const target = host?.shadowRoot?.querySelector(`[data-line="${line}"]`)
    if (target instanceof HTMLElement) return target.scrollIntoView({ block: "center" })
    // Virtualized files render only the lines in view: pierre rows are 24 px (session-ui `virtualMetrics`).
    scroller.scrollTop = Math.max(0, (line - 1) * 24 - scroller.clientHeight / 3)
  }
  createEffect(
    on(
      () => props.jump,
      () => requestAnimationFrame(jump),
      { defer: true },
    ),
  )
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.isComposing ||
      event.code !== "KeyF" ||
      event.shiftKey ||
      event.altKey ||
      !(event.ctrlKey || event.metaKey)
    )
      return
    if (!find.handle) return
    event.preventDefault()
    // Before the window's shortcut listener: Ctrl+F here is the file's find bar, not the session find (19.13).
    event.stopPropagation()
    find.handle.focus()
  }
  return (
    <div
      ref={(scroller) => (element.scroller = scroller)}
      class="own-files-code"
      tabIndex={-1}
      data-testid="files-code"
      data-own-file-find=""
      onKeyDown={onKeyDown}
    >
      <props.kit.File
        mode="text"
        file={{ name: props.path, contents: props.text, cacheKey: cacheKey() }}
        media={{ mode: "off" }}
        search={search}
        selectedLines={props.line ? { start: props.line, end: props.line } : null}
        enableLineSelection
        onRendered={jump}
        class="select-text"
      />
    </div>
  )
}

/** Markdown and mermaid previews: relative images and links resolve against the document's folder. */
function MarkdownView(props: {
  readonly kit: FilesKit
  readonly controller: FilesController
  readonly path: string
  readonly text: string
}) {
  const base = () => (isAbsolute(props.path) ? "" : dirname(props.path))
  const readImage = async (src: string, signal: AbortSignal) => {
    const folder = props.controller.directory()
    const runtime = props.controller.runtime()
    if (!folder || !runtime) return undefined
    const place = locate(folder, src, base())
    if (!place.inside || !place.path) return undefined
    const bytes = await runtime.client().file.read({ location: { directory: folder }, path: place.path }, { signal })
    return new Blob([bytes.slice()], { type: artifactMime(place.path) ?? "application/octet-stream" })
  }
  return (
    <props.kit.MarkdownProvider
      readImage={readImage}
      openLocalFile={(href) => void props.controller.open(href, { base: base() })}
    >
      <div class="own-files-markdown" data-testid="files-markdown">
        <props.kit.Markdown
          text={props.text}
          cacheKey={`${props.path}:${sampledChecksum(props.text) ?? ""}`}
          class="select-text"
        />
      </div>
    </props.kit.MarkdownProvider>
  )
}

/** An SVG as an image: scripts inside it never run in an `<img>`. */
function SvgPreview(props: { readonly text: string; readonly name: string }) {
  const src = createObjectUrl(() => new Blob([props.text], { type: "image/svg+xml" }))
  return <ImageStage src={src()} name={props.name} />
}

function BlobMedia(props: {
  readonly content: Extract<FileContent, { type: "media" }>
  readonly name: string
  readonly onInfo: (info: string | undefined) => void
}) {
  const src = createObjectUrl(() => props.content.blob)
  return <Media kind={props.content.kind} src={src()} name={props.name} blob onInfo={props.onInfo} />
}

function Media(props: {
  readonly kind: ViewKind
  readonly src: string
  readonly name: string
  /** A `blob:` URL: a page CSP without `frame-src blob:` blocks it in frames (content.ts). */
  readonly blob: boolean
  readonly onInfo: (info: string | undefined) => void
}) {
  const text = useFilesText()
  const [failed, setFailed] = createSignal(false)
  createEffect(
    on(
      () => props.src,
      () => setFailed(false),
    ),
  )
  return (
    <Show when={!failed()} fallback={<p class="own-files-state">{text("own.files.mediaError")}</p>}>
      <Switch fallback={<p class="own-files-state">{text("own.files.binaryUnknown")}</p>}>
        <Match when={props.kind === "image"}>
          <ImageStage src={props.src} name={props.name} onInfo={props.onInfo} onError={() => setFailed(true)} />
        </Match>
        <Match when={props.kind === "pdf"}>
          <PdfFrame src={props.src} name={props.name} blob={props.blob} />
        </Match>
        <Match when={props.kind === "video"}>
          <div class="own-files-stage">
            <video
              class="own-files-media"
              controls
              preload="metadata"
              playsinline
              src={props.src}
              data-testid="files-video"
              onError={() => setFailed(true)}
              onLoadedMetadata={(event) =>
                props.onInfo(`${event.currentTarget.videoWidth} × ${event.currentTarget.videoHeight}`)
              }
            />
          </div>
        </Match>
        <Match when={props.kind === "audio"}>
          <div class="own-files-stage">
            <audio
              controls
              preload="metadata"
              src={props.src}
              data-testid="files-audio"
              onError={() => setFailed(true)}
            />
          </div>
        </Match>
      </Switch>
    </Show>
  )
}

/** Fits the pane; a click shows an image larger than the pane at 1:1 (upstream `ArtifactImage`). */
function ImageStage(props: {
  readonly src: string
  readonly name: string
  readonly onInfo?: (info: string | undefined) => void
  readonly onError?: () => void
}) {
  const text = useFilesText()
  const [state, setState] = createSignal({ zoom: "fit" as "fit" | "actual", large: false })
  const element = { stage: undefined as HTMLDivElement | undefined }
  createEffect(
    on(
      () => props.src,
      () => setState({ zoom: "fit", large: false }),
    ),
  )
  return (
    <div
      ref={(stage) => (element.stage = stage)}
      class="own-files-stage"
      data-checker
      data-zoom={state().zoom}
      data-testid="files-image-stage"
    >
      <img
        class="own-files-media"
        src={props.src}
        alt={props.name}
        draggable={false}
        data-testid="files-image"
        title={state().large ? text(state().zoom === "fit" ? "own.files.actual" : "own.files.fit") : undefined}
        onError={() => props.onError?.()}
        onLoad={(event) => {
          const image = event.currentTarget
          const stage = element.stage
          props.onInfo?.(`${image.naturalWidth} × ${image.naturalHeight}`)
          setState((value) => ({
            ...value,
            large: stage
              ? image.naturalWidth > stage.clientWidth - 32 || image.naturalHeight > stage.clientHeight - 32
              : false,
          }))
        }}
        onClick={() => {
          if (!state().large) return
          setState((value) => ({ ...value, zoom: value.zoom === "fit" ? "actual" : "fit" }))
        }}
      />
    </div>
  )
}

/** The browser's PDF viewer. A CSP that forbids `blob:` frames shows a note instead of an empty frame. */
function PdfFrame(props: { readonly src: string; readonly name: string; readonly blob: boolean }) {
  const text = useFilesText()
  const [blocked, setBlocked] = createSignal(false)
  onMount(() => {
    if (!props.blob) return
    const listener = (event: SecurityPolicyViolationEvent) => {
      if (event.blockedURI.startsWith("blob:") && /^(frame|child|default)-src/.test(event.effectiveDirective))
        setBlocked(true)
    }
    document.addEventListener("securitypolicyviolation", listener)
    onCleanup(() => document.removeEventListener("securitypolicyviolation", listener))
  })
  return (
    <Show
      when={!blocked()}
      fallback={
        <p class="own-files-state" data-testid="files-pdf-blocked">
          {text("own.files.pdfBlocked")}
        </p>
      }
    >
      <iframe
        class="own-files-frame"
        title={props.name}
        // PDF Open Parameters: no thumbnail pane, fitted to the pane width (upstream ArtifactFrame).
        src={`${props.src}#navpanes=0&view=FitH`}
        referrerPolicy="no-referrer"
        data-testid="files-pdf"
      />
    </Show>
  )
}

function createObjectUrl(blob: () => Blob) {
  return createMemo(() => {
    const url = URL.createObjectURL(blob())
    onCleanup(() => URL.revokeObjectURL(url))
    return url
  })
}
