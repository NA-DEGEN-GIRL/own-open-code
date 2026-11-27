// What the image card shows (02 §9.6, decisions IM-23), apart from the card's view so it is testable without a DOM.
import type { OwnImage } from "@own/protocol"

/** A base64 `data:` URI of an image type the card draws; anything else (a URL, an HTML or XML type) is not drawn. */
const DATA_URI = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+=*$/

/**
 * The picture of a made image, or `undefined`. A GIF or an SVG comes from the card's `preview` (the result's file part
 * holds only the GIF's first frame and no SVG at all); a PNG, JPEG or WebP from the result's file part. Either way the
 * card puts it only in an `<img src>`: an SVG there is an image (no scripts, no outside requests), never markup in the
 * page, whatever the bytes hold.
 */
export function shown(part: { readonly card?: Pick<OwnImage.CardData, "preview">; readonly image?: string }) {
  const preview = part.card?.preview
  if (preview !== undefined && DATA_URI.test(preview) && /^data:image\/(gif|svg\+xml);/.test(preview)) return preview
  if (part.image !== undefined && DATA_URI.test(part.image) && !part.image.startsWith("data:image/svg+xml;")) return part.image
  return undefined
}

/** A `data:` URI whose bytes a transcript page left out (core P-055, the store's `omitToolFileData`). */
export function omitted(image: string | undefined) {
  return image !== undefined && image.startsWith("data:") && image.endsWith(";base64,")
}
