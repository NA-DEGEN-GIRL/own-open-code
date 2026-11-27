// The layout audit (the user's 2026-10-18 reports): measures what a screen or an open menu, popover, dialog or pill
// shows and reports the defects a person sees at once but no functional test catches:
//   - `wrap`: text meant for one line that broke into two (`Fast · 한\n도 ×2.5`). A control's (button, link, menu
//     item, option, tab, radio, switch) only text, any text of a control up to 40 characters, a tag, chip, pill or badge,
//     and in a popup any text up to 24 characters must be one line. Lines are counted from the text's own line boxes
//     (Range rects), not guessed from heights;
//   - `ellipsis`: text an ellipsis shortens; `cut`: text its box or an ancestor clips without one (a scroll container
//     ends the search: what it hides is reachable); `spill`: text painted outside its control;
//   - `offscreen`: a popup or its text partly outside the window;
//   - `hscroll`: the page, or a column or popup with a horizontal scroll that is not code or a table;
//   - `wco`: in the desktop shell, a control or text under the window's caption buttons (the band's right end,
//     `emulateWindowControls`), like the manual viewer's 닫기 before 65f9d05640.
// Findings an allowlist entry (allowlist.ts) matches stay in the report with the entry's reason and do not fail.
import fs from "node:fs"
import path from "node:path"
import type { Locator, Page, TestInfo } from "@playwright/test"

export type Kind = "wrap" | "ellipsis" | "cut" | "spill" | "offscreen" | "hscroll" | "wco"

export interface Allowed {
  readonly kinds: ReadonlyArray<Kind>
  /** Matches the element or one of its ancestors (`Element.closest`). */
  readonly selector: string
  /** Why it is not a defect (a design choice), for the report. */
  readonly reason: string
}

export interface Finding {
  readonly kind: Kind
  /** `1440 session`, `1440 session · composer-speed`. */
  readonly view: string
  /** The nearest `data-testid` and the element: `[composer-speed-menu] button[role=menuitemradio].own-cp-menu-item`. */
  readonly element: string
  readonly text: string
  readonly detail: string
  /** The allowlist entry's reason, when one matched. */
  readonly allowed?: string
}

/** The window's caption buttons in the desktop shell at zoom 1: three 46 px buttons at the right end of the 44 px band. */
export const WINDOW_BUTTONS = { right: 138, height: 44 } as const

/**
 * The desktop shell's title bar band in a browser page: what the shell's own `data-wco` and `env(titlebar-area-*)`
 * give the CSS (`.own-app[data-wco]`, `--own-header-h`, `--own-wco-right`, `:root[data-wco-visible]`). Code that
 * reads `host.capabilities.windowControlsOverlay` in script (the sidebar's band row) keeps the web host's layout.
 */
export async function emulateWindowControls(
  page: Page,
  band: { readonly right: number; readonly height: number } = WINDOW_BUTTONS,
) {
  await page.addInitScript((input) => {
    const apply = () => {
      const root = document.documentElement
      if (!root.hasAttribute("data-wco-visible")) {
        root.setAttribute("data-wco-visible", "")
        root.style.setProperty("--own-wco-band-right", `${input.right}px`)
        root.style.setProperty("--own-wco-band-height", `${input.height}px`)
      }
      for (const app of document.querySelectorAll<HTMLElement>(".own-app:not([data-wco])")) {
        app.setAttribute("data-wco", "")
        app.style.setProperty("--own-wco-right", `${input.right}px`)
        app.style.setProperty("--own-header-h", `${input.height}px`)
      }
    }
    new MutationObserver(apply).observe(document, { childList: true, subtree: true })
  }, band)
}

/** Collects the findings of one view: the whole page (`scope` omitted) or one open popup. */
export class Audit {
  readonly findings: Finding[] = []
  readonly screens: string[] = []
  readonly notes: string[] = []
  private readonly seen = new Set<string>()

  constructor(
    // A Playwright test's info, or a run's own output folder (own-desktop scripts/zoom-level.ts on the shell).
    private readonly info: Pick<TestInfo, "outputPath" | "attach">,
    readonly width: number,
    private readonly allowlist: ReadonlyArray<Allowed>,
    private readonly band: { readonly right: number; readonly height: number } | undefined,
    private readonly matched: Set<string>,
  ) {}

  /** Measures the page or `scope` and keeps what it finds (each finding once per view and element). */
  async check(page: Page, view: string, scope?: Locator) {
    const marker = `ua-${this.findings.length}-${Date.now()}`
    if (scope) await scope.first().evaluate((element, id) => element.setAttribute("data-ua-root", id), marker)
    const found = await page.evaluate(measure, {
      root: scope ? `[data-ua-root="${marker}"]` : null,
      band: this.band ?? null,
      allowed: this.allowlist.map((entry) => ({
        kinds: [...entry.kinds],
        selector: entry.selector,
        reason: entry.reason,
      })),
    })
    if (scope)
      await scope
        .first()
        .evaluate((element) => element.removeAttribute("data-ua-root"))
        .catch(() => undefined)
    for (const item of found) {
      const key = `${view}|${item.kind}|${item.element}|${item.text}`
      if (this.seen.has(key)) continue
      this.seen.add(key)
      if (item.allowed) this.matched.add(item.allowed)
      this.findings.push({ ...item, view: `${this.width} ${view}` })
    }
  }

  /** A screenshot of `targets` (their union, padded, inside the window) for the review by eye. */
  async shoot(page: Page, name: string, targets: ReadonlyArray<Locator>) {
    const boxes = (
      await Promise.all(
        targets.map((target) =>
          target
            .first()
            .boundingBox()
            .catch(() => null),
        ),
      )
    ).filter((box) => box !== null)
    const viewport = page.viewportSize() ?? { width: this.width, height: 900 }
    const clip = boxes.length
      ? (() => {
          const left = Math.max(0, Math.min(...boxes.map((box) => box.x)) - 16)
          const top = Math.max(0, Math.min(...boxes.map((box) => box.y)) - 16)
          const right = Math.min(viewport.width, Math.max(...boxes.map((box) => box.x + box.width)) + 16)
          const bottom = Math.min(viewport.height, Math.max(...boxes.map((box) => box.y + box.height)) + 16)
          return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
        })()
      : undefined
    const file = this.info.outputPath("screens", `${this.width}`, `${name.replace(/[^\w.-]+/g, "_")}.png`)
    await page.screenshot({ path: file, ...(clip ? { clip } : {}) })
    this.screens.push(file)
  }

  /**
   * Opens a popup (`open`), finds it (`popup`, or the outermost menu, listbox, dialog, popover or tooltip that was not
   * on screen before), checks it, takes its picture, runs `inside` on it (what it opens in turn) and closes it
   * (`close`, else Escape, then its trigger again).
   */
  async popup(
    page: Page,
    view: string,
    input: {
      readonly name: string
      readonly open: () => Promise<unknown>
      readonly trigger?: Locator
      readonly popup?: Locator
      readonly close?: () => Promise<unknown>
      readonly inside?: (popup: Locator, view: string) => Promise<unknown>
    },
  ) {
    await page.evaluate(markSeen)
    const opened = await input.open().then(
      () => true,
      (error: unknown) => {
        this.notes.push(`${this.width} ${view} · ${input.name}: did not open (${String(error).split("\n")[0]})`)
        return false
      },
    )
    if (!opened) return
    const found = input.popup ?? (await newPopup(page))
    const shown = found
      ? await found
          .first()
          .waitFor({ state: "visible", timeout: 5_000 })
          .then(() => true)
          .catch(() => false)
      : false
    if (!found || !shown) {
      this.notes.push(`${this.width} ${view} · ${input.name}: no popup appeared`)
      await page.keyboard.press("Escape").catch(() => undefined)
      return
    }
    // Placement runs on the next frame (popover `place()`, the composer's menus).
    await page.waitForTimeout(250)
    await this.check(page, `${view} · ${input.name}`, found)
    await this.shoot(page, `${view}-${input.name}`, input.trigger ? [found, input.trigger] : [found])
    if (input.inside)
      await input.inside(found.first(), `${view} · ${input.name}`).catch((error: unknown) => {
        this.notes.push(`${this.width} ${view} · ${input.name}: inside failed (${String(error).split("\n")[0]})`)
      })
    const closed = () =>
      found
        .first()
        .waitFor({ state: "hidden", timeout: 1_500 })
        .then(() => true)
        .catch(() => false)
    if (input.close) await input.close()
    else await page.keyboard.press("Escape")
    if (!(await closed())) await page.keyboard.press("Escape")
    // A phone has no Escape key: the popup's own 닫기 or 취소, else its trigger again.
    const cancel = found.getByRole("button", { name: /^(닫기|취소)$/ }).first()
    if (!(await closed()) && (await cancel.isVisible().catch(() => false)))
      await cancel.click({ timeout: 2_000 }).catch(() => undefined)
    if (!(await closed()) && input.trigger)
      await input.trigger
        .first()
        .click({ timeout: 2_000 })
        .catch(() => undefined)
    if (!(await closed())) this.notes.push(`${this.width} ${view} · ${input.name}: did not close`)
    await page.evaluate(closeLeftovers)
  }

  violations() {
    return this.findings.filter((item) => !item.allowed)
  }

  /** `<name>.json` and a readable `<name>.txt` in the test's output folder, attached to the report. */
  async write(name = "ui-audit") {
    const lines = [
      ...this.violations().map((item) => line(item)),
      ...(this.findings.some((item) => item.allowed) ? ["", "allowed:"] : []),
      ...this.findings.filter((item) => item.allowed).map((item) => `${line(item)}  — ${item.allowed}`),
      ...(this.notes.length ? ["", "notes:", ...this.notes] : []),
    ]
    const text = this.info.outputPath(`${name}.txt`)
    fs.mkdirSync(path.dirname(text), { recursive: true })
    fs.writeFileSync(text, `${lines.join("\n")}\n`)
    fs.writeFileSync(
      this.info.outputPath(`${name}.json`),
      JSON.stringify({ findings: this.findings, notes: this.notes, screens: this.screens }, null, 2),
    )
    await this.info.attach(`${name}.txt`, { path: text, contentType: "text/plain" })
    return lines
  }
}

export function line(item: Finding) {
  return `${item.kind.padEnd(9)} ${item.view} — ${item.element} "${item.text}" (${item.detail})`
}

const POPUP =
  '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], dialog[open], [popover]:popover-open, [role="tooltip"], .own-cp-menu, .own-cp-pop, [data-own-overlay]'

/**
 * In the page: closes modal dialogs and popovers that a probe left open and were not open before it (a frame that
 * kept the focus swallows Escape), so one stuck popup does not block every probe after it.
 */
function closeLeftovers() {
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog[open]:not([data-ua-seen])")) dialog.close()
  for (const popover of document.querySelectorAll<HTMLElement>("[popover]:popover-open:not([data-ua-seen])"))
    popover.hidePopover()
}

/** Marks the popups on screen now, so `newPopup` finds only what the next action opens. */
function markSeen() {
  const selector =
    '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], dialog[open], [popover]:popover-open, [role="tooltip"], .own-cp-menu, .own-cp-pop, [data-own-overlay]'
  for (const element of document.querySelectorAll("[data-ua-seen]")) element.removeAttribute("data-ua-seen")
  for (const element of document.querySelectorAll(selector))
    if (element.checkVisibility()) element.setAttribute("data-ua-seen", "")
}

/** The outermost popup that appeared since `markSeen`, waited for up to five seconds (a lazy chunk's first load). */
async function newPopup(page: Page) {
  const found = await page
    .waitForFunction(
      (selector) => {
        const fresh = [...document.querySelectorAll<HTMLElement>(selector)].filter(
          (element) => !element.hasAttribute("data-ua-seen") && element.checkVisibility(),
        )
        const outer = fresh.filter((element) => !fresh.some((other) => other !== element && other.contains(element)))
        const first = outer[0]
        if (!first) return false
        const id = `ua-pop-${Math.random().toString(36).slice(2)}`
        first.setAttribute("data-ua-popup", id)
        return id
      },
      POPUP,
      { timeout: 5_000, polling: 100 },
    )
    .then((handle) => handle.jsonValue() as Promise<string>)
    .catch(() => undefined)
  return found ? page.locator(`[data-ua-popup="${found}"]`) : undefined
}

interface Probe {
  readonly root: string | null
  readonly band: { readonly right: number; readonly height: number } | null
  readonly allowed: ReadonlyArray<{
    readonly kinds: ReadonlyArray<string>
    readonly selector: string
    readonly reason: string
  }>
}

/** Runs in the page: every finding of the root (a popup) or of the whole document. Self-contained for `evaluate`. */
function measure(probe: Probe) {
  type Raw = { kind: Kind; element: string; text: string; detail: string; allowed?: string }
  const out: Raw[] = []
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  const root = probe.root ? document.querySelector<HTMLElement>(probe.root) : document.body
  if (!root) return out
  const inPopup = probe.root !== null
  const CONTROL =
    'button, a[href], [role="button"], [role="link"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="tab"], [role="radio"], [role="switch"], [role="checkbox"], summary'
  const TAGLIKE = '.own-tag, [class*="-pill"], [class*="-chip"], [class*="-badge"], [class*="own-sw-tag"]'
  const SKIP = "script, style, noscript, template, svg, textarea, input, select, option"
  const range = document.createRange()
  const style = new Map<Element, CSSStyleDeclaration>()
  const css = (element: Element) => {
    const known = style.get(element)
    if (known) return known
    const computed = getComputedStyle(element)
    style.set(element, computed)
    return computed
  }
  const shown = (element: Element) =>
    element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !element.closest("[inert]")
  const text = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim()
  const describe = (element: Element) => {
    const holder = element.closest("[data-testid]")
    const role = element.getAttribute("role")
    const classes = [...element.classList]
      .filter((name) => !name.includes(":") && !name.includes("[") && name.length < 32)
      .slice(0, 2)
      .map((name) => `.${name}`)
      .join("")
    const own = holder === element ? "" : `${element.tagName.toLowerCase()}${role ? `[role=${role}]` : ""}${classes}`
    return `${holder ? `[${holder.getAttribute("data-testid")}]` : ""} ${own}`.trim()
  }
  const add = (kind: Kind, element: Element, detail: string, label = text(element)) => {
    const allowed = probe.allowed.find((entry) => entry.kinds.includes(kind) && element.closest(entry.selector))
    out.push({
      kind,
      element: describe(element),
      text: label.slice(0, 80),
      detail,
      ...(allowed ? { allowed: allowed.reason } : {}),
    })
  }
  const round = (value: number) => Math.round(value)

  // Text leaves: elements with their own text, grouped with their direct text nodes.
  const leaves = new Map<Element, Text[]>()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text
    const parent = textNode.parentElement
    if (!parent || !textNode.data.trim() || parent.closest(SKIP)) continue
    const list = leaves.get(parent)
    if (list) list.push(textNode)
    else leaves.set(parent, [textNode])
  }

  for (const [leaf, nodes] of leaves) {
    if (!shown(leaf)) continue
    const rects = nodes.flatMap((node) => {
      range.selectNodeContents(node)
      return [...range.getClientRects()].filter((rect) => rect.width > 0.5 && rect.height > 0.5)
    })
    if (!rects.length) continue
    const box = leaf.getBoundingClientRect()
    // Visually hidden text (screen-reader labels) is 1 px or clipped away on purpose.
    if (box.width <= 2 || box.height <= 2 || css(leaf).clipPath !== "none" || css(leaf).clip.startsWith("rect"))
      continue
    const label = nodes
      .map((node) => node.data)
      .join("")
      .replace(/\s+/g, " ")
      .trim()

    // wrap: count the line boxes of the leaf's own text.
    const mids: number[] = []
    for (const rect of rects) {
      const mid = rect.top + rect.height / 2
      if (!mids.some((other) => Math.abs(other - mid) < rect.height * 0.5)) mids.push(mid)
    }
    if (mids.length > 1) {
      const control = leaf.closest(CONTROL)
      const owned = control && root.contains(control) ? control : undefined
      const only = owned
        ? [...leaves.keys()].filter((other) => owned.contains(other) && shown(other)).length === 1
        : false
      const single = (owned && (only || label.length <= 40)) || leaf.closest(TAGLIKE) || (inPopup && label.length <= 24)
      if (single)
        add("wrap", leaf, `${mids.length} lines${owned && owned !== leaf ? ` in ${describe(owned)}` : ""}`, label)
    }

    // ellipsis / cut: the first clipping box from the leaf up, until a scroll container.
    let clipped = false
    for (
      let element: Element | null = leaf;
      element && element !== document.documentElement;
      element = element.parentElement
    ) {
      const computed = css(element)
      const scrollX = computed.overflowX === "auto" || computed.overflowX === "scroll"
      const scrollY = computed.overflowY === "auto" || computed.overflowY === "scroll"
      const clipX = computed.overflowX === "hidden" || computed.overflowX === "clip"
      const clipY = computed.overflowY === "hidden" || computed.overflowY === "clip"
      if (clipX || clipY) {
        const outer = element.getBoundingClientRect()
        const left = outer.left + element.clientLeft
        const top = outer.top + element.clientTop
        const right = left + element.clientWidth
        const bottom = top + element.clientHeight
        const overX = clipX && rects.some((rect) => rect.right > right + 1 || rect.left < left - 1)
        const overY = clipY && rects.some((rect) => rect.bottom > bottom + 2 || rect.top < top - 2)
        if (overX || overY) {
          // An ellipsis: `text-overflow` on one line, `-webkit-line-clamp` over several.
          const clamp = computed.getPropertyValue("-webkit-line-clamp")
          const ellipsis =
            overX && !overY ? computed.textOverflow === "ellipsis" : !overX && clamp !== "" && clamp !== "none"
          const by = element === leaf ? "its own box" : describe(element)
          add(
            ellipsis ? "ellipsis" : "cut",
            leaf,
            `${overX ? `${round(Math.max(...rects.map((rect) => rect.right)) - right)} px past the right` : ""}${overX && overY ? ", " : ""}${overY ? "below the bottom" : ""} of ${by}`,
            label,
          )
          clipped = true
          break
        }
      }
      if (scrollX || scrollY || element === root) break
    }

    // spill: text painted outside its control (one that does not clip).
    const control = leaf.closest(CONTROL)
    if (!clipped && control && root.contains(control) && control !== root) {
      const outer = control.getBoundingClientRect()
      if (
        rects.some(
          (rect) => rect.right > outer.right + 2 || rect.left < outer.left - 2 || rect.bottom > outer.bottom + 3,
        )
      )
        add("spill", leaf, `outside ${describe(control)}`, label)
    }

    // offscreen: a popup's text painted outside the window (what its scroll or clipping boxes show of it).
    if (inPopup) {
      const painted = rects.map((rect) => {
        let box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
        for (
          let element: Element | null = leaf.parentElement;
          element && element !== document.body;
          element = element.parentElement
        ) {
          const computed = css(element)
          if (computed.overflowX === "visible" && computed.overflowY === "visible") continue
          const outer = element.getBoundingClientRect()
          box = {
            left: Math.max(box.left, outer.left),
            top: Math.max(box.top, outer.top),
            right: Math.min(box.right, outer.right),
            bottom: Math.min(box.bottom, outer.bottom),
          }
        }
        return box
      })
      const shownPart = painted.filter((box) => box.right - box.left > 1 && box.bottom - box.top > 1)
      if (shownPart.some((box) => box.right > vw + 1 || box.left < -1 || box.bottom > vh + 1 || box.top < -1))
        add("offscreen", leaf, "outside the window", label)
    }
  }

  if (inPopup) {
    const rect = root.getBoundingClientRect()
    if (rect.right > vw + 1 || rect.left < -1 || rect.bottom > vh + 1 || rect.top < -1)
      add(
        "offscreen",
        root,
        `popup at ${round(rect.left)},${round(rect.top)} to ${round(rect.right)},${round(rect.bottom)} in ${vw}×${vh}`,
        text(root).slice(0, 40),
      )
  }

  // hscroll: the page, or a box with a horizontal scrollbar (code and tables, and boxes around a table, scroll on purpose).
  if (!inPopup) {
    const page = document.scrollingElement ?? document.documentElement
    if (page.scrollWidth > vw + 1)
      add("hscroll", document.documentElement, `page ${page.scrollWidth} px in ${vw} px`, "")
  }
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (element.scrollWidth <= element.clientWidth + 1 || element.clientWidth === 0) continue
    const computed = css(element)
    if (computed.overflowX !== "auto" && computed.overflowX !== "scroll") continue
    if (element.closest("pre, code, table, [data-own-scroll-x]") || element.querySelector(":scope > table")) continue
    if (!shown(element)) continue
    add("hscroll", element, `${element.scrollWidth} px in ${element.clientWidth} px`, text(element).slice(0, 40))
  }

  // wco: controls and text under the caption buttons that are really on top there.
  if (probe.band) {
    const band = { left: vw - probe.band.right, top: 0, right: vw, bottom: probe.band.height }
    const under = (rect: DOMRect) =>
      Math.min(rect.right, band.right) - Math.max(rect.left, band.left) > 2 &&
      Math.min(rect.bottom, band.bottom) - Math.max(rect.top, band.top) > 2
    const onTop = (element: Element, rect: DOMRect) => {
      const x = (Math.max(rect.left, band.left) + Math.min(rect.right, band.right)) / 2
      const y = (Math.max(rect.top, band.top) + Math.min(rect.bottom, band.bottom)) / 2
      const hit = document.elementFromPoint(x, y)
      return !!hit && (hit === element || element.contains(hit) || hit.contains(element))
    }
    const candidates = [
      ...root.querySelectorAll(CONTROL),
      ...[...leaves.keys()].filter((leaf) => !leaf.closest(CONTROL)),
    ]
    for (const element of candidates) {
      if (!shown(element)) continue
      const rect = element.getBoundingClientRect()
      if (under(rect) && onTop(element, rect))
        add(
          "wco",
          element,
          `${round(rect.left)}–${round(rect.right)} × ${round(rect.top)}–${round(rect.bottom)} under the window buttons (x ≥ ${band.left}, y < ${band.bottom})`,
        )
    }
  }
  return out
}
