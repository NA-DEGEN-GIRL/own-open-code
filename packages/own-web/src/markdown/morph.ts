// Patches the DOM of a streaming answer's last (live) block to the block's newest HTML (03 §20.2 R3). Upstream
// rebuilt that block on every update as one span per word with a keyed reconcile (session-ui markdown-solid.tsx),
// which kept the main thread busy with style recalculation and native DOM work while a session streamed
// (own/reports/ui-perf-many-sessions-2026-10.md cause 4). Here nodes that did not change keep their identity (a
// selection inside them survives), text that grew gets only its new end appended, and only that newest text fades in:
// one span per update instead of one per word.

/** The fade-in span of new text: session-ui markdown.css animates `[data-markdown-word][data-markdown-enter]`. */
const FADE = "data-markdown-enter"
/** A fade span becomes plain text again after this long (its 180 ms animation has ended). */
const SETTLE_MS = 400
/**
 * Attributes code outside the block's HTML adds to its elements: a favicon's `data-loaded` (load listener), a local
 * image's `src` once the host read it (markdown-image.ts), an image's preview button attributes (image-preview.tsx).
 * A patch never removes them.
 */
const RUNTIME = new Set(["data-loaded", "src", "role", "aria-haspopup", "aria-label", "tabindex"])

export type LiveBlock = {
  /** The fade spans in this block, oldest first, with the time they were added. */
  readonly fades: { span: HTMLSpanElement; at: number }[]
}

export function createLiveBlock(): LiveBlock {
  return { fades: [] }
}

/**
 * Makes `target`'s children equal to `source`'s (a detached tree of the block's new HTML; its nodes are moved, not
 * copied). With `fade`, text that is new since the last patch is wrapped in a fade span.
 */
export function patchLiveBlock(live: LiveBlock, target: Element, source: ParentNode, now: number, fade = true) {
  // A final patch leaves no fade span behind; a live one settles the spans whose fade has ended.
  settle(live, fade ? now - SETTLE_MS : Number.POSITIVE_INFINITY)
  patchChildren(target, source, fade ? (span) => live.fades.push({ span, at: now }) : undefined)
}

function settle(live: LiveBlock, before: number) {
  while (live.fades.length && live.fades[0]!.at <= before) {
    const span = live.fades.shift()!.span
    // A span the patch removed (or whose subtree it replaced) has nothing to merge into.
    if (!span.parentNode) continue
    const text = span.textContent ?? ""
    const previous = span.previousSibling
    if (previous instanceof Text) {
      previous.appendData(text)
      span.remove()
      continue
    }
    span.replaceWith(text)
  }
}

type Faded = (span: HTMLSpanElement) => void

function patchChildren(target: Node, source: ParentNode, faded: Faded | undefined) {
  let current = target.firstChild
  for (let next = source.firstChild; next; ) {
    const following: ChildNode | null = next.nextSibling
    current = patchNode(target, current, next, faded)
    next = following
  }
  while (current) {
    const after: ChildNode | null = current.nextSibling
    current.remove()
    current = after
  }
}

/** Patches the node at `current` (or inserts before it) to match `next`; returns the target node after the match. */
function patchNode(target: Node, current: ChildNode | null, next: ChildNode, faded: Faded | undefined) {
  if (next instanceof Text) {
    if (current && textLike(current)) return patchText(target, current, next.data, faded)
    target.insertBefore(next, current)
    fadeText(next, faded)
    return current
  }
  if (next instanceof Element && current instanceof Element && current.tagName === next.tagName && !fadeSpan(current)) {
    patchAttributes(current, next)
    patchChildren(current, next, faded)
    return current.nextSibling
  }
  if (current && !textLike(current) && current.nodeType === next.nodeType && !(next instanceof Element)) {
    // A comment (or another leaf): same value, same node.
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue
    return current.nextSibling
  }
  // Something else stands here: the new node takes its place (a text run is replaced as a whole).
  const after = current ? (textLike(current) ? afterRun(current) : current.nextSibling) : null
  for (let node = current; node && node !== after; ) {
    const following: ChildNode | null = node.nextSibling
    node.remove()
    node = following
  }
  target.insertBefore(next, after)
  if (next instanceof Element) fadeTree(next, faded)
  return after
}

/**
 * A run of text nodes and fade spans in the target stands for one text node of the new HTML: the common start is
 * kept, the rest of the run is cut, and what is new is appended (faded).
 */
function patchText(target: Node, start: ChildNode, want: string, faded: Faded | undefined) {
  const after = afterRun(start)
  let kept = 0
  let node: ChildNode | null = start
  while (node && node !== after) {
    const text = node.textContent ?? ""
    if (want.startsWith(text, kept)) {
      kept += text.length
      node = node.nextSibling
      continue
    }
    // The first node that differs keeps its common start; the rest of the run goes.
    const common = commonPrefix(text, want, kept)
    if (common > 0) {
      const holder = node instanceof Text ? node : node.firstChild
      if (holder instanceof Text) holder.deleteData(common, holder.length - common)
      kept += common
      node = node.nextSibling
    }
    while (node && node !== after) {
      const following: ChildNode | null = node.nextSibling
      node.remove()
      node = following
    }
  }
  if (kept === want.length) return after
  const rest = want.slice(kept)
  const last = after ? after.previousSibling : target.lastChild
  // Without a fade the new end joins the text before it, so the nodes are laid out like the HTML's.
  if (!faded && kept > 0 && last instanceof Text) last.appendData(rest)
  else {
    const text = document.createTextNode(rest)
    target.insertBefore(text, after)
    fadeText(text, faded)
  }
  return after
}

function commonPrefix(text: string, want: string, offset: number) {
  let length = 0
  while (length < text.length && offset + length < want.length && text[length] === want[offset + length]) length++
  return length
}

function afterRun(start: ChildNode) {
  let node: ChildNode | null = start
  while (node && textLike(node)) node = node.nextSibling
  return node
}

function textLike(node: Node) {
  return node instanceof Text || fadeSpan(node)
}

function fadeSpan(node: Node): node is HTMLSpanElement {
  return node instanceof HTMLSpanElement && node.hasAttribute(FADE)
}

function patchAttributes(current: Element, next: Element) {
  for (const attribute of Array.from(next.attributes))
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value)
  for (const attribute of Array.from(current.attributes))
    if (!next.hasAttribute(attribute.name) && !RUNTIME.has(attribute.name)) current.removeAttribute(attribute.name)
}

/** Wraps a new text node in a fade span; whitespace stays bare (between table rows a span would make a cell). */
function fadeText(text: Text, faded: Faded | undefined) {
  if (!faded || !/\S/.test(text.data)) return
  const span = document.createElement("span")
  span.setAttribute("data-markdown-word", "")
  span.setAttribute(FADE, "")
  text.replaceWith(span)
  span.append(text)
  faded(span)
}

function fadeTree(root: Element, faded: Faded | undefined) {
  if (!faded) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  while (walker.nextNode()) texts.push(walker.currentNode as Text)
  for (const text of texts) fadeText(text, faded)
}
