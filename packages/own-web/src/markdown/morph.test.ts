import { describe, expect, test } from "bun:test"
import { createLiveBlock, patchLiveBlock } from "./morph"

function html(markup: string) {
  const template = document.createElement("template")
  template.innerHTML = markup
  return template.content
}

/** The block's HTML without fade spans: what it must equal after a patch. */
function plain(element: Element) {
  const copy = element.cloneNode(true) as Element
  copy.querySelectorAll("span[data-markdown-enter]").forEach((span) => span.replaceWith(span.textContent ?? ""))
  return copy.innerHTML
}

describe("live block patch", () => {
  test("a growing paragraph keeps its nodes and fades in only the new end", () => {
    const target = document.createElement("div")
    const live = createLiveBlock()
    patchLiveBlock(live, target, html("<p>스트리밍 응답은</p>"), 0, false)
    const paragraph = target.firstChild
    const first = paragraph?.firstChild
    expect(target.innerHTML).toBe("<p>스트리밍 응답은</p>")

    patchLiveBlock(live, target, html("<p>스트리밍 응답은 프레임마다</p>"), 10)
    expect(target.firstChild).toBe(paragraph)
    expect(paragraph?.firstChild).toBe(first)
    expect(target.innerHTML).toBe(
      '<p>스트리밍 응답은<span data-markdown-word="" data-markdown-enter=""> 프레임마다</span></p>',
    )

    patchLiveBlock(live, target, html("<p>스트리밍 응답은 프레임마다 <strong>한 번</strong></p>"), 20)
    expect(plain(target)).toBe("<p>스트리밍 응답은 프레임마다 <strong>한 번</strong></p>")
    // The space between is not faded (bare whitespace), the new element's text is.
    expect(target.querySelectorAll("[data-markdown-enter]")).toHaveLength(2)

    // Spans whose fade has ended turn back into text; the start of the paragraph is still the first node.
    patchLiveBlock(live, target, html("<p>스트리밍 응답은 프레임마다 <strong>한 번만</strong></p>"), 1_000)
    expect(paragraph?.firstChild).toBe(first)
    expect(target.querySelectorAll("[data-markdown-enter]")).toHaveLength(1)
    expect(plain(target)).toBe("<p>스트리밍 응답은 프레임마다 <strong>한 번만</strong></p>")
  })

  test("healed markup that changes shape is replaced; a final patch leaves exactly the HTML", () => {
    const target = document.createElement("div")
    const live = createLiveBlock()
    const steps = [
      "<p>a <em>b</em></p>",
      "<p>a <strong>bo</strong></p>",
      "<ul>\n<li>one</li>\n</ul>\n",
      "<ul>\n<li>one</li>\n<li>tw</li>\n</ul>\n",
      "<ul>\n<li>one</li>\n<li>two <code>x</code></li>\n</ul>\n",
    ]
    steps.forEach((step, index) => {
      patchLiveBlock(live, target, html(step), index * 10)
      expect(plain(target)).toBe(step)
    })
    patchLiveBlock(live, target, html("<ul>\n<li>one</li>\n<li>two <code>x</code> end</li>\n</ul>\n"), 60, false)
    expect(target.innerHTML).toBe("<ul>\n<li>one</li>\n<li>two <code>x</code> end</li>\n</ul>\n")
    expect(target.querySelector("li")?.childNodes).toHaveLength(1)
  })

  test("a table gains rows without spans between them; text that shrank is cut", () => {
    const target = document.createElement("div")
    const live = createLiveBlock()
    const table = (rows: string) =>
      `<table>\n<thead>\n<tr>\n<th>항목</th>\n<th>상태</th>\n</tr>\n</thead>\n<tbody>${rows}</tbody></table>\n`
    patchLiveBlock(live, target, html(table("<tr>\n<td>a</td>\n<td>b</td>\n</tr>\n")), 0, false)
    const head = target.querySelector("thead")
    patchLiveBlock(live, target, html(table("<tr>\n<td>a</td>\n<td>b</td>\n</tr>\n<tr>\n<td>c</td>\n<td>d</td>\n</tr>\n")), 5)
    expect(target.querySelector("thead")).toBe(head)
    expect(target.querySelectorAll("tbody > span, tr > span, table > span")).toHaveLength(0)
    expect(target.querySelectorAll("tbody tr")).toHaveLength(2)
    patchLiveBlock(live, target, html("<p>abc</p>"), 10)
    patchLiveBlock(live, target, html("<p>ab</p>"), 20)
    expect(plain(target)).toBe("<p>ab</p>")
  })

  test("attributes follow the HTML, except the ones the page adds (favicon loaded, local image source)", () => {
    const target = document.createElement("div")
    const live = createLiveBlock()
    patchLiveBlock(live, target, html('<p><a href="https://e.com/a" class="external-link">e</a> <img data-local-image="x.png"></p>'), 0, false)
    target.querySelector("img")!.setAttribute("src", "blob:local")
    target.querySelector("a")!.setAttribute("data-loaded", "")
    patchLiveBlock(live, target, html('<p><a href="https://e.com/ab" class="external-link">e</a> <img data-local-image="x.png"> more</p>'), 10)
    expect(target.querySelector("a")?.getAttribute("href")).toBe("https://e.com/ab")
    expect(target.querySelector("a")?.hasAttribute("data-loaded")).toBe(true)
    expect(target.querySelector("img")?.getAttribute("src")).toBe("blob:local")
  })
})
