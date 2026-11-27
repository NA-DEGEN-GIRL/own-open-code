// `상세 보기`'s body (SK2, 2026-10-24; 03 §19.6.1): a skill's SKILL.md is another tool's or a repository's text, so it is
// rendered as untrusted markdown. marked turns it into HTML in ./detail.worker (2026-10-25: off the main thread, ended
// after a few seconds; a failed or slow parse shows the text as it is); a DOMPurify instance of this module (not the
// transcript's shared one) keeps text, formatting, tables, code and links, and drops scripts, styles, frames, forms and
// every event attribute. Pictures load nothing by default: every remote one (an image, and since 2026-10-25 a
// `background`, a video `poster`, an SVG `image`/`use` link, a `url()` in a style, an `srcset`) becomes an image that is
// held back until the user asks (`remoteImages`), and then loads without a referrer; no other attribute that makes a
// browser load something survives. A local or relative picture has no file the page could load and shows its alt
// text. Links open outside the app (`_blank`, no opener, no referrer). Part of the lazy detail chunk only.
import DOMPurify from "dompurify"
import type { SkillParseRequest, SkillParseResponse } from "./detail.worker"

const FORBID_TAGS = [
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "link",
  "meta",
  "base",
  "svg",
  "math",
  "video",
  "audio",
  "source",
  "track",
  "picture",
]

/** Attributes that make a browser fetch something, or name what it would fetch: only `a[href]` and `img[src]` stay. */
const URL_ATTRS = [
  "background",
  "poster",
  "src",
  "srcset",
  "imagesrcset",
  "lowsrc",
  "dynsrc",
  "longdesc",
  "href",
  "xlink:href",
  "data",
  "codebase",
  "classid",
  "archive",
  "action",
  "formaction",
  "ping",
  "cite",
  "manifest",
  "profile",
  "icon",
  "srcdoc",
  "usemap",
  "style",
]

const REMOTE = /^(?:https?:)?\/\//i

export interface RenderedBody {
  readonly html: string
  /** Remote pictures held back (shown as their alt text until `remoteImages`). */
  readonly hidden: number
}

/** The body parsed (`html`), or shown as its text (`raw`): the parse failed or ran past its time. */
export type ParsedBody = { readonly html: string } | { readonly raw: "timeout" | "failed" }

/** How long the worker may parse once it runs, and how long it may take to start (a cold dev server is slow). */
const PARSE_MS = 3_000
const START_MS = 20_000

/**
 * marked in ./detail.worker, a worker of its own that is ended when it answers, fails or runs past `ms` (counted
 * from its start, so a slow chunk load is not the parse's time). Without workers (unit tests) it is `failed`.
 */
export function parseSkillBody(markdown: string, ms = PARSE_MS): Promise<ParsedBody> {
  if (typeof Worker === "undefined") return Promise.resolve({ raw: "failed" })
  return new Promise((resolve) => {
    const state: { worker?: Worker; timer?: ReturnType<typeof setTimeout> } = {}
    const done = (result: ParsedBody) => {
      clearTimeout(state.timer)
      state.worker?.terminate()
      resolve(result)
    }
    // A worker the page may not start (CSP, an old browser) is a failed parse: the text shows as it is.
    try {
      state.worker = new Worker(new URL("./detail.worker.ts", import.meta.url), { type: "module" })
    } catch {
      return done({ raw: "failed" })
    }
    state.timer = setTimeout(() => done({ raw: "timeout" }), START_MS)
    state.worker.onmessage = (event: MessageEvent<SkillParseResponse | { readonly ready: true }>) => {
      const data = event.data
      if ("ready" in data) {
        clearTimeout(state.timer)
        state.timer = setTimeout(() => done({ raw: "timeout" }), ms)
        return
      }
      done("html" in data ? { html: data.html } : { raw: "failed" })
    }
    state.worker.onerror = () => done({ raw: "failed" })
    state.worker.postMessage({ id: 1, markdown } satisfies SkillParseRequest)
  })
}

/** The parsed body's HTML made safe to show (see the module comment), with the count of remote pictures held. */
export function sanitizeSkillBody(
  html: string,
  options: {
    readonly remoteImages?: boolean
    /** How a held image reads: `[<image>: <alt>]` (`그림` in Korean). */
    readonly image?: string
  } = {},
): RenderedBody {
  const purifier = DOMPurify(window)
  const state = { hidden: 0 }
  // By tag name: the nodes come from DOMPurify's own parsed document, not this window's classes.
  purifier.addHook("afterSanitizeAttributes", (node) => {
    const tag = node.nodeName
    for (const name of URL_ATTRS)
      if (!(tag === "A" && name === "href") && !(tag === "IMG" && name === "src")) node.removeAttribute(name)
    if (tag === "A") {
      if (!node.getAttribute("href")) return
      node.setAttribute("target", "_blank")
      node.setAttribute("rel", "noopener noreferrer nofollow")
      node.setAttribute("referrerpolicy", "no-referrer")
      return
    }
    if (tag !== "IMG") return
    node.setAttribute("referrerpolicy", "no-referrer")
    node.setAttribute("loading", "lazy")
    const src = node.getAttribute("src") ?? ""
    if (/^data:image\//i.test(src)) return
    if (REMOTE.test(src)) {
      if (options.remoteImages) return
      state.hidden += 1
    }
    node.removeAttribute("src")
    node.setAttribute("data-skill-image", "held")
  })
  const fragment = purifier.sanitize(pictures(html), {
    USE_PROFILES: { html: true },
    FORBID_TAGS,
    FORBID_ATTR: ["style", "class", "id", "srcset", "formaction", "action", "ping"],
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    RETURN_DOM_FRAGMENT: true,
  })
  // A held image is its alt text (as text), not a broken picture.
  for (const image of fragment.querySelectorAll('img[data-skill-image="held"]')) {
    const shown = document.createElement("span")
    shown.className = "own-sk-detail-img"
    const alt = image.getAttribute("alt") || image.getAttribute("title")
    shown.textContent = `[${options.image ?? "image"}${alt ? `: ${alt}` : ""}]`
    image.replaceWith(shown)
  }
  const box = document.createElement("div")
  box.append(fragment)
  return { html: box.innerHTML, hidden: state.hidden }
}

/**
 * Every remote picture of `html` as an `<img>` of its own, so the image rules above hold it back, count it and, when
 * asked, load it without a referrer: an `srcset`-only image takes its first candidate, a `background` an image at the
 * start of its cell (before its table for the table's own rows), a `poster`, an SVG `image`/`use` link or an image
 * button one before the element (DOMPurify drops those elements), a style's `url()` one at the element's start. The
 * attributes go. Read in an inert document (`DOMParser`: nothing loads, no script runs).
 */
function pictures(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html")
  for (const element of doc.body.querySelectorAll("*")) {
    const tag = element.localName
    if (tag === "img" && !element.getAttribute("src")) {
      const first = (element.getAttribute("srcset") ?? "").trim().split(/[\s,]+/)[0]
      if (first) element.setAttribute("src", first)
    }
    const found = [
      ...take(element, "background"),
      ...take(element, "poster"),
      ...(["image", "use", "feimage"].includes(tag.toLowerCase())
        ? [...take(element, "href"), ...take(element, "xlink:href")]
        : []),
      ...(tag === "input" ? take(element, "src") : []),
      ...[...(element.getAttribute("style") ?? "").matchAll(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi)].map(
        (match) => match[2] ?? "",
      ),
    ].filter((url) => REMOTE.test(url))
    for (const url of found) {
      const image = doc.createElement("img")
      image.setAttribute("src", url)
      image.setAttribute("alt", "")
      if (["table", "thead", "tbody", "tfoot", "tr", "colgroup", "col"].includes(tag))
        (element.closest("table") ?? element).before(image)
      else if (["video", "audio", "input", "picture", "object", "embed"].includes(tag)) element.before(image)
      else if (element.namespaceURI === "http://www.w3.org/2000/svg") (element.closest("svg") ?? element).before(image)
      else element.prepend(image)
    }
    element.removeAttribute("style")
  }
  return doc.body.innerHTML
}

/** An attribute's value, removed from the element. */
function take(element: Element, name: string) {
  const value = element.getAttribute(name)
  element.removeAttribute(name)
  return value ? [value.trim()] : []
}
