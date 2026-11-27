// Inline pictures as `blob:` URLs (./object-url.ts): Chromium keeps every `data:` URI an image loaded for as long as
// the page lives, so the transcript must not hand one to an `<img>`.
import { afterEach, describe, expect, test } from "bun:test"
import { resolveObjectURL } from "node:buffer"
import { imageSrc } from "./object-url"

const picture = (id: number) => `data:image/png;base64,${Buffer.from(`picture ${id}`).toString("base64")}`

afterEach(() => document.body.replaceChildren())

describe("imageSrc", () => {
  test("a base64 data: URI becomes a blob: URL holding its bytes; anything else is not one", async () => {
    const url = imageSrc(picture(1))
    expect(url).toStartWith("blob:")
    const blob = resolveObjectURL(url!)
    expect(blob?.type).toBe("image/png")
    expect(await blob?.text()).toBe("picture 1")
    expect(imageSrc("https://example.com/a.png")).toBeUndefined()
    expect(imageSrc("media:abc")).toBeUndefined()
    expect(imageSrc("data:text/plain,hello")).toBeUndefined()
  })

  test("a picture keeps its URL while cached: a remounted row does not decode it again", () => {
    expect(imageSrc(picture(2))).toBe(imageSrc(picture(2))!)
  })

  test("past eight pictures the oldest off screen is revoked, one still shown in an <img> stays", () => {
    const shown = imageSrc(picture(10))!
    const image = document.createElement("img")
    image.setAttribute("src", shown)
    document.body.append(image)
    const old = imageSrc(picture(11))!
    Array.from({ length: 10 }, (_, index) => imageSrc(picture(20 + index)))
    expect(imageSrc(picture(10))).toBe(shown)
    expect(imageSrc(picture(11))).not.toBe(old)
  })
})
