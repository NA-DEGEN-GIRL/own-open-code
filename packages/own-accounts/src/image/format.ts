export * as ImageFormat from "./format.js"

import type { OwnImage } from "@own/protocol"

/**
 * The bytes own's image tool reads and saves (02 §9.6, decisions IM-21..IM-24): which format they really are (the saved
 * file's extension, the file part's MIME and the card follow the bytes, never the request), an animated GIF's frames and
 * its first frame as a still, and the size and transparency checks of a markup layer. Pure byte reading, no decoder.
 */

/** The format of the bytes, by their signature; an SVG by its root element after an XML prolog. */
export function sniff(bytes: Uint8Array): OwnImage.Format | undefined {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png"
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "jpeg"
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp"
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "gif"
  if (SVG_ROOT.test(new TextDecoder().decode(bytes.subarray(0, 4096)).replace(/^﻿/, ""))) return "svg"
  return undefined
}

const SVG_ROOT = /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>/]/i

/** The pixel size of a PNG, JPEG, WebP or GIF, as stored (before any EXIF orientation). */
export function dimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  const format = sniff(bytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (format === "png" && bytes.length >= 24) return { width: view.getUint32(16), height: view.getUint32(20) }
  if (format === "gif" && bytes.length >= 10) return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  if (format === "jpeg") return jpegSize(bytes, view)
  if (format === "webp") return webpSize(bytes, view)
  return undefined
}

/**
 * Whether a PNG can hold transparent pixels: an alpha channel (grey or RGB with alpha) or a `tRNS` chunk. A layer
 * without one was flattened onto the image, which OpenAI's guide says not to do. Whether some pixel really is
 * transparent needs the decoded pixels; OpenAI checks that itself.
 */
export function pngAlpha(bytes: Uint8Array) {
  if (sniff(bytes) !== "png" || bytes.length < 26) return false
  const colorType = bytes[25]
  if (colorType === 4 || colorType === 6) return true
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const scan = (offset: number): boolean => {
    if (offset + 8 > bytes.length) return false
    const type = ascii(bytes, offset + 4, offset + 8)
    if (type === "tRNS") return true
    if (type === "IDAT" || type === "IEND") return false
    return scan(offset + 12 + view.getUint32(offset))
  }
  return scan(8)
}

/**
 * An animated GIF's frame count and its first frame as a GIF of its own (the header, the global palette, the first
 * frame's control extension and image; no loop extension), which every model that reads images takes. `undefined` for
 * bytes that are not a well-formed GIF.
 */
export function gifFrames(bytes: Uint8Array): { readonly frames: number; readonly first: Uint8Array } | undefined {
  if (sniff(bytes) !== "gif" || bytes.length < 13) return undefined
  const packed = bytes[10]!
  const header = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 0x07) + 1) : 0)
  // A frame's data is thousands of 255-byte sub-blocks: a loop, not recursion.
  const blocks = (start: number) => {
    let offset = start
    while (offset < bytes.length && bytes[offset] !== 0) offset += 1 + bytes[offset]!
    return offset < bytes.length ? offset + 1 : undefined
  }
  const walk = (
    offset: number,
    state: { frames: number; first?: { start: number; end: number }; control?: { start: number; end: number } },
  ): typeof state | undefined => {
    const byte = bytes[offset]
    if (byte === 0x3b) return state
    if (byte === 0x21) {
      const end = blocks(offset + 2)
      if (end === undefined) return undefined
      const control = bytes[offset + 1] === 0xf9 && state.first === undefined ? { start: offset, end } : state.control
      return walk(end, { ...state, ...(control ? { control } : {}) })
    }
    if (byte === 0x2c) {
      if (offset + 10 > bytes.length) return undefined
      const local = bytes[offset + 9]!
      const data = offset + 10 + (local & 0x80 ? 3 * 2 ** ((local & 0x07) + 1) : 0)
      const end = blocks(data + 1)
      if (end === undefined) return undefined
      return walk(end, { ...state, frames: state.frames + 1, first: state.first ?? { start: state.control?.start ?? offset, end } })
    }
    return undefined
  }
  const found = walk(header, { frames: 0 })
  if (!found?.first || header > bytes.length) return undefined
  const first = new Uint8Array(header + (found.first.end - found.first.start) + 1)
  first.set(bytes.subarray(0, header))
  // The control extension sits right before its image (a plain image needs none), so one slice holds both.
  first.set(bytes.subarray(found.first.start, found.first.end), header)
  first[first.length - 1] = 0x3b
  return { frames: found.frames, first }
}

function jpegSize(bytes: Uint8Array, view: DataView) {
  const scan = (offset: number): { width: number; height: number } | undefined => {
    if (offset + 9 > bytes.length || bytes[offset] !== 0xff) return undefined
    const marker = bytes[offset + 1]!
    const length = view.getUint16(offset + 2)
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) }
    return scan(offset + 2 + length)
  }
  return scan(2)
}

function webpSize(bytes: Uint8Array, view: DataView) {
  if (bytes.length < 30) return undefined
  const chunk = ascii(bytes, 12, 16)
  const u24 = (offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
  if (chunk === "VP8X") return { width: u24(24) + 1, height: u24(27) + 1 }
  if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
  if (chunk === "VP8L") {
    const bits = view.getUint32(21, true)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  return undefined
}

function starts(bytes: Uint8Array, signature: ReadonlyArray<number>) {
  return signature.every((byte, index) => bytes[index] === byte)
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.subarray(start, end))
}
