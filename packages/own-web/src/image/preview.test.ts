// The image card's picture (02 §9.6, decisions IM-23): a GIF animates from the card's `preview` (the result's file part
// is only its first frame), an SVG shows from `preview` as an image and never as markup in the page, a PNG from the file
// part as before; anything that is not a base64 image `data:` URI is not drawn. Solid components do not render under
// `bun test`, so the card's wiring is read from its source here; the browser e2e (e2e/transcript.spec.ts) renders it.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { omitted, shown } from "./preview"

const PNG = "data:image/png;base64,iVBORw0KGgo="
const GIF = "data:image/gif;base64,R0lGODlhAQABAAAAACw="
const FIRST = "data:image/gif;base64,R0lGODlhAQABAAAAADs="
const SVG = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64")}`

describe("the image card's picture (IM-23)", () => {
  test("GIF: the whole animation from preview, not the first frame of the file part", () => {
    expect(shown({ card: { preview: GIF }, image: FIRST })).toBe(GIF)
  })

  test("SVG: from preview only; an SVG file part (never sent by own) is not drawn", () => {
    expect(shown({ card: { preview: SVG } })).toBe(SVG)
    expect(shown({ image: SVG })).toBeUndefined()
  })

  test("PNG: the file part as before (cards without preview, older conversations)", () => {
    expect(shown({ card: {}, image: PNG })).toBe(PNG)
    expect(shown({ image: PNG })).toBe(PNG)
  })

  test("nothing else is drawn: a URL, a non-image or a non-base64 data URI, a raster preview", () => {
    expect(shown({ card: { preview: "https://example.com/x.gif" } })).toBeUndefined()
    expect(shown({ card: { preview: "data:text/html;base64,PGgxPg==" } })).toBeUndefined()
    expect(shown({ card: { preview: "data:image/svg+xml,<svg onload=alert(1)>" } })).toBeUndefined()
    expect(shown({ card: { preview: PNG } })).toBeUndefined()
    expect(shown({ image: "javascript:alert(1)" })).toBeUndefined()
  })

  test("the card puts the picture only in <img src>, never as markup", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "line.tsx")).text()
    // A page without tool file bytes (core P-055) leaves the image empty; the card reads it from its whole message,
    // and that image passes the same check.
    expect(source).toContain("<Show when={shown(part) ?? shown({ ...part, image: read() })}>")
    // As a `blob:` URL of those bytes (./object-url.ts), so the page does not keep the `data:` URI.
    expect(source).toContain("const src = createMemo(() => imageSrc(props.uri) ?? props.uri)")
    expect(source).toMatch(/<img src=\{src\(\)\}/)
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|DOMParser|<svg|<object|<iframe|<embed/)
    // The format line, a format other than asked, a lowered GIF frame size and an SVG's authoring tokens (priced or not).
    for (const key of [
      "own.image.line.gif",
      "own.image.line.svg",
      "own.image.line.asked",
      "own.image.line.resized",
      "own.image.line.svgAuthor",
      "own.image.line.svgAuthorPaid",
    ])
      expect(source).toContain(`"${key}"`)
  })

  test("an image whose bytes the transcript page left out is read on its own, nothing else", () => {
    expect(omitted("data:image/png;base64,")).toBe(true)
    expect(omitted(PNG)).toBe(false)
    expect(omitted(undefined)).toBe(false)
    expect(omitted("https://example.com/x;base64,")).toBe(false)
    expect(shown({ image: "data:image/png;base64," })).toBeUndefined()
  })
})
