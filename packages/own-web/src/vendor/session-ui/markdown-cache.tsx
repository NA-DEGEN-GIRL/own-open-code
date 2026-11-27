// Substitutes packages/session-ui/src/components/markdown-cache.tsx @ 698800f59c (MIT). See own/ledger/vendored.yaml
// own: swapped in at build time by vite/plugins.ts `substitute` (FORK.md §7 kind "substitute"); changes are marked
// "own:". A streaming answer touches every one of its blocks on each update, so with more blocks than the LRU holds
// (upstream 200) every update re-parsed and re-sanitized them all: 40–60 ms long tasks per frame late in a long
// answer (PF4). The cache is larger. (DOMPurify's config set once, own's earlier change, is upstream since #60549.)
// The sanitizer (allow-lists, containment, app links, renderer fragments) is upstream's as of 698800f59c (#63002).
// own: upstream #58439 (80ea2130e7): shared abort reason and disposal error, so disposal pins no batch.
// own: a picture or video poster on another host is never loaded by itself; a picture becomes a link (decisions TLM).
import { abort } from "@opencode/util/abort"
import { checksum } from "@opencode/util/encode"
import { parseSmallMarkdown } from "@opencode/ui/context/marked-base"
import DOMPurify from "dompurify"
// own: the upstream siblings (not in session-ui's exports), by path; the same module instances markdown.tsx uses.
import { markdownWorkerDisposed, parseMarkdown } from "./markdown-worker"
import { localImagePath, localLinkPath } from "../../../../session-ui/src/components/markdown-image"
import type { MarkdownHTML } from "../../../../session-ui/src/components/markdown-worker-protocol"

export type MarkdownCacheEntry = {
  raw: string
  src?: string
  hash: string
  html: string
}

// own: upstream 200. The entries of one streaming answer are all touched per update and must fit (see the header).
const max = 2_000
const cache = new Map<string, MarkdownCacheEntry>()
const pending = new Map<
  string,
  { raw: string; promise: Promise<MarkdownCacheEntry>; controller: AbortController; consumers: Set<symbol> }
>()
// A private instance keeps this hook set separate from other DOMPurify users.
const purifier = typeof window !== "undefined" ? DOMPurify(window) : DOMPurify

const rendered = typeof window !== "undefined" ? DOMPurify(window) : DOMPurify

// Sanitized renderer output by its source HTML, most recently used last.
const renderedFragments = new Map<string, Node>()

if (typeof window !== "undefined" && purifier.isSupported) {
  const appLinks = new WeakMap<HTMLAnchorElement, string>()
  const files = new WeakMap<HTMLAnchorElement, string>()
  const images = new WeakMap<HTMLImageElement, string>()

  const prose = new Set(
    "a abbr b bdi bdo blockquote br caption center cite code col colgroup data dd del details dfn div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q rp rt ruby s samp small span strong sub summary sup table tbody td tfoot th thead time tr u ul var wbr".split(
      " ",
    ),
  )

  // The rest of what the chat rendered before this allow-list: legacy, sectioning and media markup. Outside `prose`,
  // each is marked for paint containment, so none can lay itself out over the app.
  const contained =
    "acronym address article aside audio big blink dir font footer header hgroup main marquee menu nav nobr picture search section source spacer strike track tt video".split(
      " ",
    )

  const paint = [
    "fill",
    "fill-opacity",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-dasharray",
    "stroke-dashoffset",
    "opacity",
  ]

  const style = document.createElement("span").style
  const allowedStyle = document.createElement("span").style

  // A config passed to sanitize() rebuilds every allow-list on each call; set once, every call reuses them.
  const config = {
    SANITIZE_NAMED_PROPS: true,
    FORBID_TAGS: ["style", "dialog"],
    FORBID_ATTR: [
      "popover",
      "popovertarget",
      "popovertargetaction",
      "command",
      "commandfor",
      "data-floating-overlay",
      "data-markdown-renderer",
    ],
    FORBID_CONTENTS: ["style", "script"],
    ADD_TAGS: ["svg", "path"],
    ADD_ATTR: ["d", "viewBox", "preserveAspectRatio", "xmlns", "target"],
  }

  purifier.setConfig({
    ...config,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
    ADD_ATTR: [...config.ADD_ATTR, "aria-label", "aria-hidden"],
    ALLOWED_TAGS: [
      ...prose,
      ...contained,
      ..."math mrow mi mn mo ms mtext mspace mfrac msqrt mroot msub msup msubsup munder mover munderover mtable mtr mtd mmultiscripts mprescripts none menclose merror mfenced mpadded mphantom mstyle semantics annotation".split(
        " ",
      ),
    ],
  })
  // These fragments still pass DOMPurify's structural/URI checks, but their renderer owns their inline geometry.
  rendered.setConfig({ ...config, USE_PROFILES: { html: true, mathMl: true }, RETURN_DOM_FRAGMENT: true })
  purifier.addHook("uponSanitizeElement", (node) => {
    // `a`, `use`, `image` and `foreignObject` inside SVG would link, reference or embed; drop them with their contents.
    if (node instanceof SVGElement && node.localName !== "svg" && node.localName !== "path") node.remove()
  })
  purifier.addHook("uponSanitizeAttribute", (node, attr) => {
    // Never import identifiers from the app's styling, focus, shortcut, form or plugin protocols. This allowlist
    // is for document content only. DOMPurify still validates every value and namespaces id and name.
    const tag = node.localName
    const name = attr.attrName

    if (node instanceof SVGElement && paint.includes(name)) {
      attr.keepAttr = svgPaint(name, attr.attrValue)

      return
    }

    const allowed =
      /^(style|id|dir|lang|title|align)$/.test(name) ||
      ((tag === "a" || tag === "img") && name === "aria-label") ||
      (tag === "a" &&
        (name === "href" ||
          name === "download" ||
          name === "name" ||
          name === "rel" ||
          (name === "target" && attr.attrValue === "_blank"))) ||
      (tag === "img" && /^(src|alt|height|width)$/.test(name)) ||
      (/^(q|blockquote|ins|del)$/.test(tag) && name === "cite") ||
      (/^(time|ins|del)$/.test(tag) && name === "datetime") ||
      (tag === "data" && name === "value") ||
      (tag === "font" && /^(color|face|size)$/.test(name)) ||
      (/^(video|audio)$/.test(tag) && /^(src|controls|loop|muted|preload|autoplay)$/.test(name)) ||
      (tag === "video" && /^(poster|playsinline|width|height)$/.test(name)) ||
      (tag === "source" && /^(src|type|srcset|sizes|media)$/.test(name)) ||
      (tag === "track" && /^(src|kind|srclang|label|default)$/.test(name)) ||
      (/^(table|col|th|td)$/.test(tag) && /^(width|colspan|rowspan|scope)$/.test(name)) ||
      (tag === "ol" && /^(start|reversed|type)$/.test(name)) ||
      (tag === "li" && name === "value") ||
      (tag === "details" && name === "open") ||
      (tag === "svg" && /^(viewbox|preserveaspectratio|xmlns|width|height)$/.test(name)) ||
      (tag === "svg" && name === "aria-hidden" && /^(true|false)$/.test(attr.attrValue)) ||
      (tag === "path" && name === "d")

    if (!allowed) {
      attr.keepAttr = false

      return
    }

    const sized = /^(?:img|table|th|td|col|svg|video)$/.test(tag)

    if ((name === "width" || (tag === "svg" && name === "height")) && sized) {
      const width = contentWidth(attr.attrValue, true)
      attr.keepAttr = !!width
      attr.attrValue = width

      return
    }

    if (attr.attrName !== "style") return
    style.cssText = attr.attrValue
    allowedStyle.cssText = ""

    for (const property of [
      "color",
      "background-color",
      "font-weight",
      "font-style",
      "text-decoration-line",
      "text-align",
    ]) {
      allowedStyle.setProperty(property, style.getPropertyValue(property))
    }

    if (sized) allowedStyle.width = contentWidth(style.width, false)

    attr.attrValue = allowedStyle.cssText
    attr.keepAttr = !!attr.attrValue
  })
  purifier.addHook("beforeSanitizeAttributes", (node) => {
    // Removing `is` does not clear Chromium's internal customized-built-in name; serialization can put it back.
    if (node instanceof Element && node.hasAttribute("is"))
      return node.replaceWith(node.ownerDocument.createTextNode(node.textContent ?? ""))

    if (node instanceof HTMLAnchorElement) {
      // Local file links never navigate the document; the host decides how to open them.
      const href = node.getAttribute("href") ?? ""
      const path = localLinkPath(href)

      const protocol = URL.parse(href)?.protocol

      if (protocol && !path && !/^(https?|file):$/.test(protocol)) {
        // Chromium navigates a `download` link it cannot fetch. Only web and file links download; another app's
        // address takes the review like every other.
        node.removeAttribute("download")

        if (href.length > 2048 || /[<>\x00-\x1f\x7f-\x9f]/.test(href)) return node.removeAttribute("href")
        node.removeAttribute("style")
        node.removeAttribute("class")

        // A card, an entire paragraph or a display formula (its slot is still empty here, so the worker marks it) is
        // not a link label. Keep its contents, but don't arm that hit area.
        if (node.querySelector(":not(b,i,em,strong,s,span,code), [data-display]")) return node.removeAttribute("href")

        appLinks.set(node, href)
      }

      if (!path) return
      files.set(node, path)
      node.removeAttribute("href")
      node.removeAttribute("target")

      return
    }

    // own: a poster on another host would load as soon as the message shows (decisions TLM, as for images below).
    if (node instanceof HTMLVideoElement && /^\s*(https?:)?\/\//i.test(node.getAttribute("poster") ?? ""))
      return node.removeAttribute("poster")

    if (!(node instanceof HTMLImageElement)) return
    const src = node.getAttribute("src") ?? ""
    // Local paths are not browser URLs. Keep them inert until the host reads them.
    const path = localImagePath(src)

    // own: a picture on another host is a link to it, never fetched on its own (decisions TLM): a model's or a tool's
    // markdown image would otherwise tell that host (any URL the text names, with whatever it carries) that the message
    // was shown, without a click. The phone's gateway refuses such images by its CSP already.
    if (!path && /^\s*(https?:)?\/\//i.test(src)) return node.replaceWith(remoteImageLink(node, src))

    if (!path) return
    images.set(node, path)
    node.removeAttribute("src")
    node.removeAttribute("srcset")
  })
  purifier.addHook("afterSanitizeAttributes", (node: Element) => {
    // This application-owned marker only adds containment. Renderer fragments never pass through this hook.
    if (
      node instanceof Element &&
      node.localName !== "body" &&
      (!prose.has(node.localName) || node.hasAttribute("id") || node.hasAttribute("name"))
    )
      node.setAttribute("data-markdown-contain", "")

    if (node instanceof HTMLImageElement) {
      const path = images.get(node)

      if (path) node.dataset.localImage = path
    }

    if (!(node instanceof HTMLAnchorElement)) return
    const file = files.get(node)

    if (file) {
      node.dataset.localLink = file
      node.setAttribute("role", "link")
      node.tabIndex = 0
    }

    const href = appLinks.get(node)

    // Never restore a stripped href. Preserve the original as inert text, including characters DOMPurify or the
    // URL parser might trim: the desktop policy checks exactly what the author wrote.
    if (href !== undefined) {
      node.dataset.appLink = href

      // Strip authored inline styling from the label, but retain inert renderer slots; they contain no author HTML.
      for (const child of Array.from(node.querySelectorAll("*")).reverse()) {
        if (child.localName === "span" && /^[0-9a-f]{32}$/.test(child.id) && !child.hasChildNodes()) continue
        child.replaceWith(...child.childNodes)
      }

      if (!node.hasAttribute("href")) {
        node.removeAttribute("tabindex")
        node.removeAttribute("role")
      }
    }

    if (node.target !== "_blank") return

    if (/^https?:$/.test(node.protocol)) node.classList.add("external-link")

    const rel = node.getAttribute("rel") ?? ""
    const set = new Set(rel.split(/\s+/).filter(Boolean))
    set.add("noopener")
    set.add("noreferrer")
    node.setAttribute("rel", Array.from(set).join(" "))
  })
}

function contentWidth(value: string, attribute: boolean) {
  const match = /^(\d+(?:\.\d+)?)(px|%)?$/i.exec(value.trim())

  if (!match) return ""
  const unit = match[2] === "%" ? "%" : attribute ? "" : "px"

  return `${Math.min(Number(match[1]), unit === "%" ? 100 : 2048)}${unit}`
}

// own: the link that stands in for a remote picture (decisions TLM): its alt text, else its address; it opens like any
// other external link, only when clicked. The sanitizer still walks it (a web link stays a link).
function remoteImageLink(image: HTMLImageElement, src: string) {
  const link = image.ownerDocument.createElement("a")
  link.setAttribute("href", src.trim())
  link.setAttribute("target", "_blank")
  link.setAttribute("rel", "noopener noreferrer")
  link.setAttribute("title", src.trim())
  link.textContent = image.getAttribute("alt")?.trim() || src.trim()
  return link
}

// Colors and plain numbers only: a paint value can reference another element (`url(#id)`), which may be outside the message.
function svgPaint(name: string, value: string) {
  if (name === "fill" || name === "stroke")
    return /^(?:[a-z]+|#[\da-f]{3,8}|(?:rgba?|hsla?)\([\d.%, /+-]{1,64}\))$/i.test(value)

  if (name === "stroke-linecap" || name === "stroke-linejoin") return /^(?:butt|round|square|bevel|miter)$/.test(value)

  if (name === "stroke-dasharray" || name === "stroke-dashoffset") return /^(?:none|[\d., -]{1,128})$/.test(value)

  return /^\d*\.?\d+$/.test(value) && Number(value) <= (name.endsWith("opacity") ? 1 : 64)
}

export function sanitizeMarkdown(html: MarkdownHTML) {
  if (!purifier.isSupported) return ""
  const template = document.createElement("template")
  // SAFETY: MarkdownHTML is the worker's typed union; strings have no out-of-band fragments.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- see SAFETY above
  const plain = typeof html === "string"
  template.content.append(purifier.sanitize(plain ? html : html.html, { RETURN_DOM_FRAGMENT: true }))

  if (plain) return template.innerHTML

  for (const [key, output] of html.fragments) {
    // Replace the complete slot, never bless it or its children. Author input cannot populate the worker's map.
    const slot = template.content.getElementById(`user-content-${key}`)

    if (!slot) continue
    slot.replaceWith(rendererFragment(output))
  }

  return template.innerHTML
}

// A streamed block is sanitized again on every delta while its formulas and code stay the same.
function rendererFragment(output: string) {
  const kept = renderedFragments.get(output)

  if (kept) {
    renderedFragments.delete(output)
    renderedFragments.set(output, kept)

    return kept.cloneNode(true)
  }

  const fragment = rendered.sanitize(output, { RETURN_DOM_FRAGMENT: true })
  renderedFragments.set(output, fragment.cloneNode(true))

  if (renderedFragments.size > 64) renderedFragments.delete(renderedFragments.keys().next().value ?? "")

  return fragment
}

/** Only the desktop session installs a reviewer for inert application targets. */
export function enableMarkdownAppLinks(source: ParentNode) {
  source.querySelectorAll<HTMLAnchorElement>("a[data-app-link]").forEach((anchor) => {
    anchor.setAttribute("role", "link")
    anchor.tabIndex = 0
  })
}

export function getCachedMarkdown(key: string) {
  return cache.get(key)
}

export function touchCachedMarkdown(key: string, value: MarkdownCacheEntry) {
  cache.delete(key)
  cache.set(key, value)

  if (cache.size <= max) return

  const first = cache.keys().next().value
  if (!first) return
  cache.delete(first)
}

export async function preloadMarkdown(text: string, cacheKey: string, signal?: AbortSignal) {
  if (signal?.aborted) throw markdownWorkerDisposed
  const block = { raw: text, src: text }
  const key = `${cacheKey}:0:full`
  if (getReadyMarkdown(block, key)) return
  await renderCachedMarkdown(block, key, signal)
}

export function getReadyMarkdown(block: { raw: string; src: string }, key?: string) {
  const cached = key ? getCachedMarkdown(key) : undefined
  if (key && cached && (cached.src ?? cached.raw) === block.src) {
    pending.delete(key)
    touchCachedMarkdown(key, cached)
    return cached
  }
  if (!purifier.isSupported) return
  try {
    const html = parseSmallMarkdown(block.src)
    if (html === undefined) return
    const hash = checksum(block.src)
    const result = { raw: block.raw, src: block.src, hash: hash ?? "", html: sanitizeMarkdown(html) }
    if (key && hash) {
      pending.delete(key)
      touchCachedMarkdown(key, result)
    }
    return result
  } catch {
    // Keep parser failures on the normal worker/escaped-text fallback path.
    return
  }
}

export async function renderCachedMarkdown(block: { raw: string; src: string }, key?: string, signal?: AbortSignal) {
  if (signal?.aborted) throw markdownWorkerDisposed
  const cached = key ? getCachedMarkdown(key) : undefined
  if (key && cached && (cached.src ?? cached.raw) === block.src) {
    pending.delete(key)
    touchCachedMarkdown(key, cached)
    return cached
  }
  const current = key ? pending.get(key) : undefined
  const job = current?.raw === block.src ? current : startMarkdown(block, key)
  const consumer = Symbol()
  job.consumers.add(consumer)
  return new Promise<MarkdownCacheEntry>((resolve, reject) => {
    const release = () => {
      signal?.removeEventListener("abort", cancel)
      // A disposed consumer must not cancel another consumer's shared parse.
      if (!job.consumers.delete(consumer) || job.consumers.size > 0) return
      abort(job.controller)
      if (key && pending.get(key) === job) pending.delete(key)
    }
    const cancel = () => {
      release()
      reject(markdownWorkerDisposed)
    }
    signal?.addEventListener("abort", cancel, { once: true })
    void job.promise.then(resolve, reject).finally(release)
  })
}

function startMarkdown(block: { raw: string; src: string }, key?: string) {
  const controller = new AbortController()
  const promise = parseMarkdown(block.src, controller.signal)
    .then((html) => {
      if (controller.signal.aborted) throw markdownWorkerDisposed
      const hash = checksum(block.src)
      const result = { raw: block.raw, src: block.src, hash: hash ?? "", html: sanitizeMarkdown(html) }
      if (key && hash && pending.get(key)?.promise === promise) touchCachedMarkdown(key, result)
      return result
    })
    .finally(() => {
      if (key && pending.get(key)?.promise === promise) pending.delete(key)
    })
  const job = { raw: block.src, promise, controller, consumers: new Set<symbol>() }
  if (key) pending.set(key, job)
  return job
}
