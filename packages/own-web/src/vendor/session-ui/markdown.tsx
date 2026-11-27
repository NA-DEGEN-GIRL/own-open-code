// Substitutes packages/session-ui/src/components/markdown.tsx @ f9e892dc85 (MIT). See own/ledger/vendored.yaml
// own: swapped in at build time by vite/plugins.ts `substitute` (FORK.md §7 kind "substitute"); changes are marked
// "own:". A streaming answer is rendered incrementally (src/markdown/stream.ts): the worker re-lexes only its tail
// (src/markdown/tail.ts), only changed blocks are rendered and written, at most once per frame, and the live block is
// patched in place with a fade on its newest text instead of one span per word (src/markdown/morph.ts). Its DOM writes
// (`commitMarkdownBlocks`) are exported for that module's tests. An answer that never streamed renders as upstream's.
// Links get no favicon from Google's service (decisions TLM).
import { useI18n } from "@opencode/ui/context/i18n"
// own: upstream #58432 (dddec8f3c1): a cleanup abort with a shared reason pins no disposed batch.
import { abort } from "@opencode/util/abort"
import { checksum } from "@opencode/util/encode"
import {
  type ComponentProps,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  createUniqueId,
  onCleanup,
  type Setter,
  splitProps,
} from "solid-js"
import { isServer, render } from "solid-js/web"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Tooltip } from "@opencode/ui/tooltip"
// own: the upstream siblings (not in session-ui's exports), by path; the worker client and the cache are own-web's
// substitutes (the same modules the build swaps in for every other importer).
import { canReusePendingBlock, completedProjection } from "../../../../session-ui/src/components/markdown-projection"
import type { Block, Projection } from "../../../../session-ui/src/components/markdown-stream"
import {
  disposeMarkdownProjection,
  disposeStreamingCode,
  highlightStreamingCode,
  MarkdownWorkerDisposedError,
  MarkdownWorkerSupersededError,
  MarkdownWorkerUnavailableError,
  projectMarkdownTail,
} from "./markdown-worker"
import { markdownBlockKey, type MarkdownToken } from "../../../../session-ui/src/components/markdown-worker-protocol"
import {
  shouldResetCodeTokens,
  type RenderedCodeState,
} from "../../../../session-ui/src/components/markdown-code-state"
import {
  getCachedMarkdown,
  getReadyMarkdown,
  renderCachedMarkdown,
  touchCachedMarkdown,
  type MarkdownCacheEntry,
} from "./markdown-cache"
import { inlineCodeKind } from "../../../../session-ui/src/components/markdown-inline-code-kind"
import { renderMermaidSvg } from "../../../../session-ui/src/components/markdown-mermaid"
import {
  useMarkdown,
  type OpenMarkdownLocalFile,
  type ReadMarkdownImage,
  type MarkdownLocalFileExists,
} from "../../../../session-ui/src/context/markdown"
import { createMarkdownImages } from "../../../../session-ui/src/components/markdown-image"
import { createImagePreview } from "../../../../session-ui/src/components/image-preview"
import { setupFragmentLinks } from "../../../../session-ui/src/components/markdown-fragment-links"
import { markSessionLinks, setupSessionLinks } from "../../../../session-ui/src/components/markdown-session-links"
import { markdownClipboardHtml } from "../../../../session-ui/src/components/markdown-clipboard"
import { createLiveBlock, patchLiveBlock, type LiveBlock } from "../../markdown/morph"
import { createStreamRenderer } from "../../markdown/stream"

type RenderedBlock =
  | (MarkdownCacheEntry & { key: string; mode: Exclude<Block["mode"], "code"> })
  | {
      key: string
      mode: "code"
      raw: string
      hash: string
      language: string
      complete: boolean
      generation: number
      stable: MarkdownToken[]
      unstable: MarkdownToken[]
    }

type RenderResult = {
  text: string
  blocks: RenderedBlock[]
  ready: boolean
}

const renderedCodeTokens = new WeakMap<HTMLDivElement, RenderedCodeState>()

// own: the patch state of a block rendered live (upstream: a Solid renderer of one span per word, markdown-solid.tsx).
const liveBlocks = new WeakMap<HTMLDivElement, LiveBlock>()

function escape(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function fallback(markdown: string) {
  return escape(markdown).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>")
}

async function code(text: string, language: string | undefined, key: string, complete = false) {
  try {
    const result = await highlightStreamingCode(key, text, language ?? "text", complete)

    return {
      language: result.language,
      generation: result.generation,
      stable: result.stable,
      unstable: result.unstable,
    }
  } catch (error) {
    if (
      !(error instanceof MarkdownWorkerDisposedError) &&
      !(error instanceof MarkdownWorkerSupersededError) &&
      !(error instanceof MarkdownWorkerUnavailableError)
    )
      console.error("Markdown highlighting worker failed", error)

    const fallbackToken: MarkdownToken = [text, ""]

    return { language: language ?? "text", generation: 0, stable: [], unstable: [fallbackToken] }
  }
}

type CopyLabels = {
  copy: string
  copied: string
}

type CopyButtonState = {
  setLabels: Setter<CopyLabels>
  setCopied: Setter<boolean>
  dispose: () => void
}

const copyButtonState = new WeakMap<HTMLElement, CopyButtonState>()

const urlPattern = /^https?:\/\/[^\s<>()`"']+$/

function codeUrl(text: string) {
  const href = text.trim().replace(/[),.;!?]+$/, "")

  if (!urlPattern.test(href)) return

  try {
    const url = new URL(href)

    return url.toString()
  } catch {
    return
  }
}

function createCopyButton(labels: CopyLabels) {
  const host = document.createElement("div")
  host.setAttribute("data-slot", "markdown-copy-button")

  const state: Partial<CopyButtonState> = {}

  const dispose = render(() => {
    const [labelState, setLabels] = createSignal(labels, { equals: false })
    const [copied, setCopied] = createSignal(false)
    state.setLabels = setLabels
    state.setCopied = setCopied

    return <MarkdownCopyButton labels={labelState()} copied={copied()} />
  }, host)

  state.dispose = dispose
  // SAFETY: `render` runs its function synchronously, so both setters are assigned before this line.
  copyButtonState.set(host, state as CopyButtonState)

  return host
}

function MarkdownCopyButton(props: { labels: CopyLabels; copied: boolean }) {
  const label = () => (props.copied ? props.labels.copied : props.labels.copy)

  return (
    <Tooltip placement="top" value={label()} forceOpen={props.copied || undefined}>
      <IconButton
        type="button"
        size="normal"
        variant="ghost-muted"
        aria-label={label()}
        icon={
          <>
            <Icon name="copy" data-copy-icon />
            <Icon name="check" data-check-icon />
          </>
        }
      />
    </Tooltip>
  )
}

// own: upstream's toolbar (#64545) holds a code block's buttons, and session-ui's markdown.css places and reveals the
// toolbar, not the button. Only the copy button is in it: the wrap and Mermaid maximize buttons are not ported.
function codeToolbar(button: HTMLElement) {
  const toolbar = document.createElement("div")
  toolbar.setAttribute("data-slot", "markdown-code-toolbar")
  toolbar.append(button)

  return toolbar
}

function setCopyState(host: HTMLElement, labels: CopyLabels, copied: boolean) {
  const state = copyButtonState.get(host)
  state?.setLabels(labels)
  state?.setCopied(copied)

  if (copied) {
    host.setAttribute("data-copied", "true")

    return
  }

  host.removeAttribute("data-copied")
}

function disposeCopyButton(host: HTMLElement) {
  copyButtonState.get(host)?.dispose()
  copyButtonState.delete(host)
}

function disposeCopyButtons(root: Element) {
  const hosts = [
    ...(root instanceof HTMLElement && root.getAttribute("data-slot") === "markdown-copy-button" ? [root] : []),
    ...Array.from(root.querySelectorAll('[data-slot="markdown-copy-button"]')).filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    ),
  ]

  hosts.forEach(disposeCopyButton)
}

// own: a live block holds no Solid root (upstream disposed its word renderer here); only its patch state goes.
function disposeRenderedMarkdown(root: Element) {
  if (root instanceof HTMLDivElement) liveBlocks.delete(root)
}

const shellLanguages = new Set(["bash", "sh", "shell", "zsh", "fish", "console", "terminal"])

function codeKind(language: string | undefined) {
  const value = language?.toLowerCase()

  if (!value) return

  if (shellLanguages.has(value)) return "shell"
}

function applyCodeMetadata(wrapper: HTMLElement, language: string | undefined) {
  if (language) wrapper.dataset.language = language
  else delete wrapper.dataset.language

  const kind = codeKind(language)

  if (kind) wrapper.dataset.codeKind = kind
  else delete wrapper.dataset.codeKind
}

function decorateMermaid(wrapper: HTMLElement, code: HTMLElement, complete: boolean) {
  if (!code.classList.contains("language-mermaid")) {
    clearMermaid(wrapper)

    return
  }

  const source = code.textContent ?? ""

  if (!source) return
  const diagram = wrapper.querySelector('[data-component="markdown-mermaid"]') ?? document.createElement("div")
  diagram.setAttribute("data-component", "markdown-mermaid")

  if (!diagram.parentElement) wrapper.appendChild(diagram)
  wrapper.dataset.mermaidPending = "true"
  const input = complete ? source : source.slice(0, source.lastIndexOf("\n") + 1)

  if (!input) return
  const attempt = `${complete ? "complete" : "streaming"}:${input.length}`

  if (wrapper.dataset.mermaidAttempt === attempt) return
  wrapper.dataset.mermaidAttempt = attempt
  void renderMermaidSvg(input)
    .then((svg) => {
      if (!svg) {
        if (complete && code.textContent === source) clearMermaid(wrapper)

        return
      }

      if (!(code.textContent ?? "").startsWith(input)) return
      diagram.innerHTML = svg
      delete wrapper.dataset.mermaidPending
      wrapper.dataset.mermaidReady = "true"
    })
    .catch(() => {
      if (!complete || code.textContent !== source) return
      clearMermaid(wrapper)
    })
}

function clearMermaid(wrapper: HTMLElement) {
  delete wrapper.dataset.mermaidAttempt
  delete wrapper.dataset.mermaidPending
  delete wrapper.dataset.mermaidReady
  wrapper.querySelector('[data-component="markdown-mermaid"]')?.remove()
}

function markCodeLinks(root: HTMLDivElement) {
  const codeNodes = Array.from(root.querySelectorAll(":not(pre) > code"))

  for (const code of codeNodes) {
    // Code inside a link already goes where the link does (upstream #63587).
    if (code.closest("a")) continue
    const href = codeUrl(code.textContent ?? "")

    if (!href) continue

    const link = document.createElement("a")
    link.href = href
    link.className = "external-link"
    link.target = "_blank"
    link.rel = "noopener noreferrer"
    code.parentNode?.replaceChild(link, code)
    link.appendChild(code)
  }
}

// Tables scroll inside a rounded frame.
function wrapTables(root: HTMLDivElement) {
  root.querySelectorAll("table").forEach((table) => {
    const wrapper = document.createElement("div")
    wrapper.dataset.component = "markdown-table"
    table.replaceWith(wrapper)
    wrapper.appendChild(table)
  })
}

function markExternalLinkFavicons(root: HTMLDivElement) {
  root.querySelectorAll<HTMLAnchorElement>("a.external-link[href]").forEach((link) => {
    if (!link.textContent?.trim() || link.querySelector("img")) return

    if (!URL.canParse(link.href)) return
    const url = new URL(link.href)

    if (url.protocol !== "http:" && url.protocol !== "https:") return

    const favicon = document.createElement("span")
    favicon.className = "markdown-link-favicon"
    favicon.setAttribute("aria-hidden", "true")

    // own: every link keeps the stylesheet's link mark (GitHub its own). Upstream asked Google's favicon service for
    // each public host as soon as a message showed, which told Google the domain of every link in a conversation
    // without a click (decisions TLM).
    if (url.hostname.toLowerCase() === "github.com") favicon.dataset.github = ""

    link.insertBefore(favicon, link.firstChild)
  })
}

function setupExternalLinkFavicons(root: HTMLDivElement) {
  const loaded = (event: Event) => {
    const image = event.target

    if (!(image instanceof HTMLImageElement) || !image.hasAttribute("data-markdown-favicon")) return

    if (image.naturalWidth > 0) image.dataset.loaded = ""
  }

  root.addEventListener("load", loaded, true)

  return () => root.removeEventListener("load", loaded, true)
}

// A path becomes a link once `localFileExists` says the file exists. A streaming block skips the check: its last code
// span may still be half written, and the block renders again once it completes.
function markInlineCode(
  source: HTMLDivElement,
  target: HTMLDivElement,
  live: boolean,
  localFileExists?: MarkdownLocalFileExists,
) {
  const checked = new Set<string>()

  for (const code of source.querySelectorAll<HTMLElement>(":not(pre) > code")) {
    delete code.dataset.inlineCodeKind
    const text = (code.textContent ?? "").trim()
    const kind = inlineCodeKind(text)

    if (kind === "url") code.dataset.inlineCodeKind = kind

    // Code inside a link already goes where the link does.
    if (kind !== "path" || live || !localFileExists || code.closest("a") || checked.has(text)) continue

    checked.add(text)
    void Promise.resolve(localFileExists(text))
      .then((exists) => {
        if (!exists) return
        target.querySelectorAll<HTMLElement>(":not(pre) > code").forEach((node) => {
          if (!node.closest("a") && (node.textContent ?? "").trim() === text) node.dataset.inlineCodeKind = "path"
        })
      })
      .catch(() => undefined)
  }
}

function localLinkTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return
  const link = target.closest("a[data-local-link]")

  if (link instanceof HTMLElement) return link.dataset.localLink
  // Bare inline paths such as `src/app.ts` open like links when the host can resolve them.
  const code = target.closest(':not(pre) > code[data-inline-code-kind="path"]')

  if (code instanceof HTMLElement && !code.closest("a")) return code.textContent?.trim() || undefined
}

function setupLocalLinks(root: HTMLDivElement, open: () => OpenMarkdownLocalFile | undefined) {
  const handleClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return
    const path = localLinkTarget(event.target)

    if (!path) return
    const handler = open()

    if (!handler) return
    event.preventDefault()
    handler(path)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.defaultPrevented) return

    if (!(event.target instanceof HTMLElement) || !event.target.matches("a[data-local-link]")) return
    const path = event.target.dataset.localLink
    const handler = open()

    if (!path || !handler) return
    event.preventDefault()
    handler(path)
  }

  root.addEventListener("click", handleClick)
  root.addEventListener("keydown", handleKeyDown)

  return () => {
    root.removeEventListener("click", handleClick)
    root.removeEventListener("keydown", handleKeyDown)
  }
}

function setupCodeCopy(root: HTMLDivElement, getLabels: () => CopyLabels) {
  const timeouts = new Map<HTMLElement, ReturnType<typeof setTimeout>>()

  const updateLabel = (button: HTMLElement) => {
    const labels = getLabels()
    const copied = button.getAttribute("data-copied") === "true"
    setCopyState(button, labels, copied)
  }

  const handleClick = async (event: MouseEvent) => {
    const target = event.target

    if (!(target instanceof Element)) return

    const button = target.closest('[data-slot="markdown-copy-button"]')

    if (!(button instanceof HTMLElement)) return
    const code = button.closest('[data-component="markdown-code"]')?.querySelector("code")
    const content = code?.textContent ?? ""

    if (!content) return
    const clipboard = navigator?.clipboard

    if (!clipboard) return
    await clipboard.writeText(content)
    const labels = getLabels()
    setCopyState(button, labels, true)
    const existing = timeouts.get(button)

    if (existing) clearTimeout(existing)
    const timeout = setTimeout(() => setCopyState(button, labels, false), 2000)
    timeouts.set(button, timeout)
  }

  const buttons = Array.from(root.querySelectorAll('[data-slot="markdown-copy-button"]'))

  for (const button of buttons) {
    if (button instanceof HTMLElement) updateLabel(button)
  }

  root.addEventListener("click", handleClick)

  return () => {
    root.removeEventListener("click", handleClick)

    for (const timeout of timeouts.values()) {
      clearTimeout(timeout)
    }

    disposeCopyButtons(root)
  }
}

// Selections that leave this message keep the browser's copy, since surrounding UI may hold hidden content.
function copySelection(event: ClipboardEvent & { currentTarget: HTMLDivElement }) {
  const selection = window.getSelection()

  if (event.defaultPrevented || !event.clipboardData || !selection || selection.isCollapsed) return
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))

  if (!ranges.every((range) => event.currentTarget.contains(range.commonAncestorContainer))) return
  event.preventDefault()
  event.clipboardData.setData("text/plain", selection.toString())
  event.clipboardData.setData(
    "text/html",
    `<meta charset="utf-8">${ranges.map((range) => markdownClipboardHtml(event.currentTarget, range)).join("")}`,
  )
}

function initialResult(
  text: string,
  key: string | undefined,
  projection: Projection,
  owner: string,
  deferUntilReady: boolean | undefined,
): RenderResult {
  if (!text) return { text, blocks: [], ready: true }
  const base = key ?? checksum(text)

  if (base) {
    const blocks = projection.blocks.flatMap((block, index) => {
      if (block.mode === "code") return []
      const cacheKey = `${base}:${index}:${block.mode}`
      const cached = block.mode === "full" ? getReadyMarkdown(block, cacheKey) : getCachedMarkdown(cacheKey)

      if (cached?.raw !== block.raw) return []

      if (block.mode !== "full") touchCachedMarkdown(cacheKey, cached)

      return [{ key: `${owner}:${cacheKey}`, mode: block.mode, ...cached }]
    })

    if (blocks.length === projection.blocks.length) return { text, blocks, ready: true }
  }

  if (deferUntilReady) return { text, blocks: [], ready: false }

  return {
    text,
    ready: false,
    blocks: [
      {
        key: "initial",
        mode: "full",
        raw: text,
        hash: checksum(text) ?? "",
        html: fallback(text),
      },
    ],
  }
}

function pendingProjection(text: string): Projection {
  return { text, blocks: text ? [{ raw: text, src: text, mode: "live" }] : [] }
}

export function Markdown(
  props: ComponentProps<"div"> & {
    text: string
    cacheKey?: string
    streaming?: boolean
    deferUntilReady?: boolean
    class?: string
    classList?: Record<string, boolean>
  },
) {
  const [local, others] = splitProps(props, ["text", "cacheKey", "streaming", "deferUntilReady", "class", "classList"])
  const i18n = useI18n()
  const markdown = useMarkdown()
  const previewImages = createImagePreview()
  const [root, setRoot] = createSignal<HTMLDivElement>()
  const owner = createUniqueId()
  const lifetime = new AbortController()
  // own: an answer that streamed stays on the incremental path (src/markdown/stream.ts) to its end; one that never
  // streamed (history, tool output, files) renders as one block, as upstream.
  const streamed = createMemo((was: boolean) => was || (!isServer && !!local.streaming), false)

  const initial = initialResult(
    local.text,
    local.cacheKey,
    local.streaming ? pendingProjection(local.text) : completedProjection(local.text),
    owner,
    local.deferUntilReady,
  )

  const [html] = createResource(
    () => {
      if (isServer)
        return {
          text: local.text,
          key: local.cacheKey,
        }
      // own: the incremental path renders a streamed answer itself.
      if (streamed()) return

      return {
        text: local.text,
        key: local.cacheKey,
      }
    },
    (src): RenderResult | Promise<RenderResult> => {
      if (isServer)
        return {
          text: src.text,
          ready: true,
          blocks: [
            {
              key: "server",
              mode: "full" as const,
              raw: src.text,
              hash: checksum(src.text) ?? "",
              html: fallback(src.text),
            },
          ],
        } satisfies RenderResult

      if (!src.text) return { text: src.text, blocks: [], ready: true } satisfies RenderResult

      if (initial.ready && initial.text === src.text) return initial

      const base = src.key ?? checksum(src.text)

      return Promise.all(
        completedProjection(src.text).blocks.map(async (block, index) => {
          const key = base ? `${base}:${index}:${block.mode}` : undefined
          const ready = getReadyMarkdown(block, key)

          return {
            key: markdownBlockKey(owner, src.key, index, block.mode),
            mode: "full" as const,
            ...(ready ?? (await renderCachedMarkdown(block, key, lifetime.signal))),
          }
        }),
      )
        .then((blocks) => ({ text: src.text, blocks, ready: true }) satisfies RenderResult)
        .catch(
          () =>
            (lifetime.signal.aborted
              ? { text: src.text, blocks: [], ready: false }
              : {
                  text: src.text,
                  ready: true,
                  blocks: [
                    {
                      key: base ?? "fallback",
                      mode: "full" as const,
                      raw: src.text,
                      hash: checksum(src.text) ?? "",
                      html: fallback(src.text),
                    },
                  ],
                }) satisfies RenderResult,
        )
    },
    { initialValue: initial },
  )

  let copyCleanup: (() => void) | undefined
  let linkCleanup: (() => void) | undefined
  let faviconCleanup: (() => void) | undefined
  let sessionLinkCleanup: (() => void) | undefined
  let fragmentLinkCleanup: (() => void) | undefined
  let appliedLabels: CopyLabels | undefined
  let readImage: ReadMarkdownImage | undefined
  let images: ReturnType<typeof createMarkdownImages> | undefined

  const copyLabels = () => ({
    copy: i18n.t("ui.message.copy"),
    copied: i18n.t("ui.message.copied"),
  })

  const refreshImages = () => {
    if (readImage === markdown?.readImage) return
    images?.dispose()
    readImage = markdown?.readImage
    images = readImage ? createMarkdownImages(readImage) : undefined
  }

  const setupListeners = (container: HTMLDivElement) => {
    if (!copyCleanup) copyCleanup = setupCodeCopy(container, copyLabels)

    if (!linkCleanup) linkCleanup = setupLocalLinks(container, () => markdown?.openLocalFile)

    if (!sessionLinkCleanup) sessionLinkCleanup = setupSessionLinks(container, () => markdown?.openSession)

    if (!fragmentLinkCleanup) fragmentLinkCleanup = setupFragmentLinks(container)

    if (!faviconCleanup) faviconCleanup = setupExternalLinkFavicons(container)
    container.toggleAttribute("data-local-links", !!markdown?.openLocalFile)
  }

  createEffect(() => {
    // own: a streamed answer's DOM belongs to the incremental renderer below.
    if (streamed()) return
    const container = root()
    const result = html.latest ?? html()
    const projected = completedProjection(local.text)
    const content = local.text ? pendingBlocks(result, projected, local.cacheKey, owner, local.deferUntilReady) : []

    if (!container) return

    if (isServer) return
    refreshImages()

    delete container.dataset.markdownReady

    if (content.length === 0) {
      disposeCopyButtons(container)
      container.innerHTML = ""
      images?.update(container)

      if (result?.ready && result.text === local.text) container.dataset.markdownReady = ""

      return
    }

    const labels = copyLabels()

    content.forEach((block, index) =>
      updateBlock(container, index, block, labels, !!markdown?.openSession, markdown?.localFileExists),
    )

    while (container.children.length > content.length) {
      const child = container.lastElementChild

      if (!child) break
      disposeCopyButtons(child)
      disposeRenderedMarkdown(child)
      child.remove()
    }

    images?.update(container)
    previewImages(container)
    container.querySelectorAll<HTMLImageElement>("img[data-markdown-favicon]").forEach((image) => {
      if (image.complete && image.naturalWidth > 0) image.dataset.loaded = ""
    })

    // A button gets the labels of the run that creates it, so the others only need new ones when the language changes.
    // Relabelling every button on each run re-rendered each one's tooltip and icon button (upstream #60538).
    if (appliedLabels?.copy !== labels.copy || appliedLabels?.copied !== labels.copied)
      container
        .querySelectorAll<HTMLElement>('[data-slot="markdown-copy-button"]')
        .forEach((button) => setCopyState(button, labels, button.dataset.copied === "true"))

    appliedLabels = labels
    setupListeners(container)

    if (result?.ready && result.text === local.text) container.dataset.markdownReady = ""
  })

  // own: the incremental renderer of a streamed answer. It writes only the blocks that changed, at most once per
  // frame; images, previews and favicons are looked at in those blocks only, not in the whole answer.
  let stream: ReturnType<typeof createStreamRenderer> | undefined

  createEffect(() => {
    if (!streamed()) return
    const container = root()

    if (!container) return
    stream ??= createStreamRenderer({
      key: owner,
      deps: {
        // Without a working worker the whole text is one block, which then falls back to escaped text (upstream's
        // fallback); a superseded or disposed request is only dropped.
        project: (key, text, live) =>
          Promise.resolve()
            .then(() => projectMarkdownTail(key, text, live))
            .catch((error: unknown) => {
              if (error instanceof MarkdownWorkerSupersededError || error instanceof MarkdownWorkerDisposedError)
                throw error
              return { from: 0, blocks: [{ raw: text, src: text, mode: "full" as const }] }
            }),
        // Upstream's choice per mode: a finished block may parse here when small, the live one always in the worker.
        markdown: (block, key, live, signal) =>
          (live ? undefined : getReadyMarkdown(block, key)) ??
          renderCachedMarkdown(block, key, signal).catch(() => ({
            raw: block.raw,
            hash: checksum(block.raw) ?? "",
            html: fallback(block.src),
          })),
        code: (key, text, language) => code(text, language, key, false),
        disposeCode,
        frame: (callback) => void requestAnimationFrame(callback),
        blockKey: (index, mode) => markdownBlockKey(owner, local.cacheKey, index, mode),
        cacheKey: (index, mode, text) => {
          const base = local.cacheKey ?? checksum(text)

          return base ? `${base}:${index}:${mode}` : undefined
        },
      },
      view: createStreamView(container, {
        context: () => {
          refreshImages()
          return {
            labels: copyLabels(),
            sessionLinks: !!markdown?.openSession,
            localFileExists: markdown?.localFileExists,
            previewImages,
            images,
          }
        },
        finished: () => !local.streaming,
        committed: () => setupListeners(container),
      }),
    })
    stream.update(local.text, local.streaming ?? false)
  })

  // own: copy buttons get their labels when made; a language change relabels the ones a streamed answer has.
  createEffect(() => {
    const labels = copyLabels()
    const container = root()

    if (!container || !streamed()) return
    container
      .querySelectorAll<HTMLElement>('[data-slot="markdown-copy-button"]')
      .forEach((button) => setCopyState(button, labels, button.dataset.copied === "true"))
  })

  onCleanup(() => {
    abort(lifetime)
    images?.dispose()

    if (copyCleanup) copyCleanup()

    if (linkCleanup) linkCleanup()

    if (sessionLinkCleanup) sessionLinkCleanup()

    if (fragmentLinkCleanup) fragmentLinkCleanup()

    if (faviconCleanup) faviconCleanup()
    stream?.dispose()

    if (streamed()) disposeMarkdownProjection(owner)
  })

  return (
    <div
      data-component="markdown"
      data-streaming={local.streaming ? "" : undefined}
      dir="auto"
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      ref={setRoot}
      onCopy={copySelection}
      {...others}
    />
  )
}

/**
 * own: writes the blocks of a streamed answer that changed (src/markdown/stream.ts) and, with `count`, removes the
 * blocks from that index on. Images, previews and favicons are handled in the written blocks only; upstream looked through
 * the whole answer on every update.
 */
export function commitMarkdownBlocks(
  container: HTMLDivElement,
  changes: ReadonlyArray<{ readonly index: number; readonly block: RenderedBlock }>,
  count: number | undefined,
  context: {
    readonly labels: CopyLabels
    readonly sessionLinks: boolean
    readonly localFileExists?: MarkdownLocalFileExists
    readonly previewImages?: (root: HTMLElement) => void
    readonly images?: { update(root: HTMLElement): void }
    readonly copyButton?: (labels: CopyLabels) => HTMLElement
  },
) {
  const touched = changes.flatMap((change) => {
    if (change.block.mode === "code")
      updateCodeBlock(container, container.children[change.index], change.block, context.labels, context.copyButton)
    else
      updateBlock(
        container,
        change.index,
        change.block,
        context.labels,
        context.sessionLinks,
        context.localFileExists,
        context.copyButton,
      )
    const element = container.children[change.index]

    return element instanceof HTMLElement ? [element] : []
  })
  const removed = count !== undefined && container.children.length > count

  while (count !== undefined && container.children.length > count) {
    const child = container.lastElementChild

    if (!child) break
    disposeCopyButtons(child)
    disposeRenderedMarkdown(child)
    child.remove()
  }

  touched.forEach((element) => {
    context.previewImages?.(element)
    element.querySelectorAll<HTMLImageElement>("img[data-markdown-favicon]").forEach((image) => {
      if (image.complete && image.naturalWidth > 0) image.dataset.loaded = ""
    })
  })

  if (removed || touched.some((element) => element.querySelector("img[data-local-image]")))
    context.images?.update(container)
}

/**
 * own: where a streamed answer's blocks go, and its ready mark. While it streams the blocks sit in one
 * `display: contents` wrapper (`data-markdown-stream`): upstream's `> [data-markdown-block]:last-child > *:last-child`
 * (markdown.css) makes Blink restyle every element of the answer whenever the container's last child changes, i.e.
 * on every new block (13 ms for an 800-element answer in the many-sessions bench, and more as it grows). The wrapper
 * keeps the container's children still; the first and last block carry `data-markdown-first`/`-last` for the same
 * margins and wrapping (transcript/transcript.css), so a new block restyles only the two blocks it concerns. Once the
 * finished answer is ready the blocks move out of the wrapper: the end is the one-shot DOM.
 */
export function createStreamView(
  container: HTMLDivElement,
  options: {
    readonly context: () => Parameters<typeof commitMarkdownBlocks>[3]
    /** The stream has ended (the next ready answer is final). */
    readonly finished: () => boolean
    readonly committed?: () => void
  },
) {
  let wrapper: HTMLDivElement | undefined
  let first: Element | null = null
  let last: Element | null = null
  const mark = (element: Element | null, previous: Element | null, name: string) => {
    if (element === previous) return element
    previous?.removeAttribute(name)
    element?.setAttribute(name, "")
    return element
  }

  return {
    commit(changes: ReadonlyArray<{ readonly index: number; readonly block: RenderedBlock }>, count: number | undefined) {
      if (wrapper?.parentNode !== container) {
        wrapper = document.createElement("div")
        wrapper.dataset.markdownStream = ""
        wrapper.style.display = "contents"
        // Blocks of an earlier render (a finished stream that changed again, or the static path) go in first.
        wrapper.append(...Array.from(container.children).filter((child) => child.hasAttribute("data-markdown-block")))
        container.replaceChildren(wrapper)
      }
      commitMarkdownBlocks(wrapper, changes, count, options.context())
      first = mark(wrapper.firstElementChild, first, "data-markdown-first")
      last = mark(wrapper.lastElementChild, last, "data-markdown-last")
      options.committed?.()
    },
    ready(ready: boolean) {
      if (ready && options.finished() && wrapper?.parentNode === container) {
        first = mark(null, first, "data-markdown-first")
        last = mark(null, last, "data-markdown-last")
        wrapper.replaceWith(...Array.from(wrapper.children))
        wrapper = undefined
      }
      if (ready) container.dataset.markdownReady = ""
      else delete container.dataset.markdownReady
    },
  }
}

function pendingBlocks(
  result: RenderResult | undefined,
  projection: Projection | undefined,
  cacheKey: string | undefined,
  owner: string,
  deferUntilReady: boolean | undefined,
) {
  if (!result) return []

  if (!projection || result.text === projection.text) return result.blocks

  if (deferUntilReady) return result.blocks
  const initial = result.blocks.length === 1 && result.blocks[0]?.key === "initial"

  return projection.blocks.map((block, index) => {
    const current = initial ? undefined : result.blocks[index]

    if (current && canReusePendingBlock(current, block)) return current
    const key = markdownBlockKey(owner, cacheKey, index, block.mode)

    if (block.mode !== "code")
      return { key, mode: block.mode, raw: block.raw, hash: String(block.raw.length), html: fallback(block.src) }

    const fallbackToken: MarkdownToken = [block.src, ""]

    return {
      key,
      mode: block.mode,
      raw: block.raw,
      hash: String(block.raw.length),
      language: block.language ?? "text",
      complete: !!block.complete,
      stable: [],
      generation: 0,
      unstable: [fallbackToken],
    }
  })
}

function disposeCode(key: string) {
  disposeStreamingCode(key)
}

function updateBlock(
  container: HTMLDivElement,
  index: number,
  block: RenderedBlock,
  labels: CopyLabels,
  sessionLinks: boolean,
  localFileExists?: MarkdownLocalFileExists,
  // own: the copy button maker (a plain host in tests, where Solid components cannot render).
  copyButton: (labels: CopyLabels) => HTMLElement = createCopyButton,
) {
  const current = container.children[index]

  if (block.mode === "code") {
    updateCodeBlock(container, current, block, labels)

    return
  }

  // own: a fence that streamed or changed becomes its new one-shot form in place, keeping its wrapper and copy button.
  if (block.mode === "full" && current instanceof HTMLDivElement && updateFence(current, block)) return

  const existing =
    current instanceof HTMLDivElement && current.dataset.markdownKey === block.key && !renderedCodeTokens.has(current)
      ? current
      : undefined

  if (existing?.dataset.markdownHash === block.hash) {
    // A block that finishes streaming keeps its DOM and the user's selection; only its file paths get checked now.
    if (existing.dataset.markdownMode === "live" && block.mode !== "live") {
      existing.dataset.markdownMode = block.mode
      markInlineCode(existing, existing, false, localFileExists)
    }

    return
  }

  const next = existing ?? document.createElement("div")
  next.dataset.markdownBlock = ""
  next.dataset.markdownKey = block.key
  next.dataset.markdownHash = block.hash
  next.dataset.markdownMode = block.mode
  next.style.display = "contents"
  const live = liveBlocks.get(next)
  // Keep live blocks in control of their DOM, including after completion.
  const source = live || block.mode === "live" ? document.createElement("div") : next

  if (source === next) disposeCopyButtons(next)
  source.innerHTML = block.html
  markInlineCode(source, next, block.mode === "live", localFileExists)
  markCodeLinks(source)
  wrapTables(source)

  // Upstream labels a reference with its session title since v2.1 (`sessionTitle`); own has no title source here, so
  // a reference keeps its id as the label and stays a button (openSession).
  if (sessionLinks) markSessionLinks(source, (id) => id)
  markExternalLinkFavicons(source)

  // own: a live block is patched to its new HTML in place, its newest text faded in (src/markdown/morph.ts), instead
  // of upstream's Solid renderer with one span per word. Its first render and a final one do not fade.
  if (live) {
    patchLiveBlock(live, next, source, performance.now(), block.mode === "live")

    return
  }

  if (block.mode === "live") {
    next.replaceChildren()
    const state = createLiveBlock()
    liveBlocks.set(next, state)
    patchLiveBlock(state, next, source, performance.now(), false)
  }

  if (block.mode !== "live") {
    next.querySelectorAll<HTMLElement>("pre > code").forEach((code) => {
      const pre = code.parentElement!
      const wrapper = document.createElement("div")
      wrapper.dataset.component = "markdown-code"
      applyCodeMetadata(
        wrapper,
        Array.from(code.classList)
          .find((name) => name.startsWith("language-"))
          ?.slice(9),
      )
      pre.replaceWith(wrapper)
      wrapper.appendChild(pre)
      wrapper.appendChild(codeToolbar(copyButton(labels)))
      decorateMermaid(wrapper, code, true)
    })
  }

  if (existing) return

  if (!current) {
    container.appendChild(next)

    return
  }

  disposeCopyButtons(current)
  disposeRenderedMarkdown(current)
  current.replaceWith(next)
}

/**
 * own: gives a code block its new one-shot DOM without rebuilding it, when it was streamed as tokens and finished, or
 * was a full fence and changed (an indented block growing, a closed fence getting its trailing blank line): the new
 * `pre` takes the old one's place in the same wrapper, and the copy button stays. Inserting an element with a
 * `data-slot` (the copy button) makes Blink check @opencode/ui's `:has([data-slot=…])` rules (tabs.css, once the
 * review or files panel loaded) and restyle every element with a `data-slot`, about 550 of them, 35 ms in the
 * many-sessions bench; a new copy button per update or per finished fence multiplied that. False (the caller renders
 * the block anew) when either side is not one plain fence (several, text around it, mermaid).
 */
function updateFence(current: HTMLDivElement, block: RenderedBlock) {
  if (block.mode === "code") return false
  const streamed = renderedCodeTokens.has(current)

  if (!streamed && (current.dataset.markdownKey !== block.key || current.dataset.markdownHash === block.hash))
    return false
  const wrapper = current.firstElementChild
  const before = wrapper?.querySelector(":scope > pre")

  if (
    !(wrapper instanceof HTMLElement) ||
    wrapper.dataset.component !== "markdown-code" ||
    wrapper.hasAttribute("data-mermaid-attempt") ||
    current.childElementCount !== 1 ||
    !before
  )
    return false
  const source = document.createElement("div")
  source.innerHTML = block.html
  const pre = source.querySelector(":scope > pre")
  const code = pre?.querySelector(":scope > code")
  const language = Array.from(code?.classList ?? [])
    .find((name) => name.startsWith("language-"))
    ?.slice(9)

  if (!pre || !code || language === "mermaid" || source.querySelectorAll("pre").length !== 1) return false
  const nodes = Array.from(source.childNodes)
  const at = nodes.indexOf(pre)

  if (nodes.some((node, index) => index !== at && !(node instanceof Text && !/S/.test(node.data)))) return false
  renderedCodeTokens.delete(current)
  current.dataset.markdownKey = block.key
  current.dataset.markdownHash = block.hash
  current.dataset.markdownMode = block.mode
  delete current.dataset.markdownComplete
  wrapper.replaceChild(pre, before)
  applyCodeMetadata(wrapper, language)
  clearMermaid(wrapper)
  // The whitespace the one-shot HTML has around the fence; the wrapper itself is not moved (that would insert it again).
  Array.from(current.childNodes).forEach((node) => node !== wrapper && node.remove())
  wrapper.before(...nodes.slice(0, at))
  wrapper.after(...nodes.slice(at + 1))

  return true
}

/** own: makes a full fence block's DOM a streaming code block's (an empty `pre` in the same wrapper). */
function adoptFence(current: HTMLDivElement) {
  const wrapper = current.firstElementChild
  const before = wrapper?.querySelector(":scope > pre")

  if (
    !(wrapper instanceof HTMLElement) ||
    wrapper.dataset.component !== "markdown-code" ||
    wrapper.hasAttribute("data-mermaid-attempt") ||
    current.childElementCount !== 1 ||
    !before
  )
    return false
  const pre = document.createElement("pre")
  pre.className = "shiki OpenCode"
  pre.appendChild(document.createElement("code"))
  wrapper.replaceChild(pre, before)
  Array.from(current.childNodes).forEach((node) => node !== wrapper && node.remove())
  delete current.dataset.markdownMode
  // A state no update continues, so the token spans are drawn from the start.
  renderedCodeTokens.set(current, { language: "", generation: -1, stableCount: 0, unstable: [], raw: " " })

  return true
}

function updateCodeBlock(
  container: HTMLDivElement,
  current: Element | undefined,
  block: Extract<RenderedBlock, { mode: "code" }>,
  labels: CopyLabels,
  copyButton: (labels: CopyLabels) => HTMLElement = createCopyButton,
) {
  // own: a block shown as a finished fence that streams again (a chunk ended right after its opening ```, which reads
  // as an empty closed fence) keeps its wrapper and copy button: only its `pre` starts over (see updateFence).
  if (current instanceof HTMLDivElement && !renderedCodeTokens.has(current) && adoptFence(current))
    current.dataset.markdownKey = block.key

  const existing =
    current instanceof HTMLDivElement && current.dataset.markdownKey === block.key && renderedCodeTokens.has(current)
      ? current
      : undefined

  const next = existing ?? document.createElement("div")
  next.dataset.markdownBlock = ""
  next.dataset.markdownKey = block.key
  next.dataset.markdownHash = block.hash
  next.dataset.markdownComplete = block.complete ? "true" : "false"
  next.style.display = "contents"

  const code = existing?.querySelector("code")

  if (code instanceof HTMLElement) {
    const wrapper = code.closest('[data-component="markdown-code"]')

    if (wrapper instanceof HTMLElement) applyCodeMetadata(wrapper, block.language)
    code.className = `language-${block.language}`
    const previous = renderedCodeTokens.get(next)

    const reset = shouldResetCodeTokens(previous, {
      language: block.language,
      generation: block.generation,
      stableCount: block.stable.length,
      raw: block.raw,
    })

    const stableCount = reset ? 0 : previous!.stableCount
    const tail = [...block.stable.slice(stableCount), ...block.unstable]
    const prior = reset ? [] : previous!.unstable
    const prefix = prior.findIndex((token, index) => !sameToken(token, tail[index]))
    const keep = stableCount + (prefix < 0 ? Math.min(prior.length, tail.length) : prefix)

    while (code.children.length > keep) code.lastElementChild?.remove()
    tail
      .slice(keep - stableCount)
      .map(createTokenSpan)
      .forEach((span) => code.appendChild(span))
    renderedCodeTokens.set(next, {
      language: block.language,
      generation: block.generation,
      stableCount: block.stable.length,
      unstable: block.unstable,
      raw: block.raw,
    })

    if (wrapper instanceof HTMLElement) decorateMermaid(wrapper, code, block.complete)

    return
  }

  const wrapper = document.createElement("div")
  wrapper.setAttribute("data-component", "markdown-code")
  applyCodeMetadata(wrapper, block.language)
  const pre = document.createElement("pre")
  pre.className = "shiki OpenCode"
  const codeElement = document.createElement("code")
  codeElement.className = `language-${block.language}`
  ;[...block.stable, ...block.unstable].map(createTokenSpan).forEach((span) => codeElement.appendChild(span))
  pre.appendChild(codeElement)
  wrapper.appendChild(pre)
  wrapper.appendChild(codeToolbar(copyButton(labels)))
  decorateMermaid(wrapper, codeElement, block.complete)
  next.appendChild(wrapper)
  renderedCodeTokens.set(next, {
    language: block.language,
    generation: block.generation,
    stableCount: block.stable.length,
    unstable: block.unstable,
    raw: block.raw,
  })

  if (current) {
    disposeCopyButtons(current)
    disposeRenderedMarkdown(current)
    current.replaceWith(next)

    return
  }

  container.appendChild(next)
}

function sameToken(left: MarkdownToken, right: MarkdownToken | undefined) {
  return !!right && left[0] === right[0] && left[1] === right[1]
}

function createTokenSpan(token: MarkdownToken) {
  const span = document.createElement("span")
  span.setAttribute("style", token[1])
  span.textContent = token[0]

  return span
}
