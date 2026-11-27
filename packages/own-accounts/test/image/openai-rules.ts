// What the real OpenAI Images API refuses for GIF and SVG, as the fake Images endpoints answer it (decisions IM-31,
// IM-33). Written from OpenAI's live answers of 2026-11-09, not from own's code, so a fake answers like the real API
// and own sending a GIF that cannot fit or an SVG without its author fails the tests:
// - a GIF's frames go on one sheet (2-8 frames 4x2 or 2x4, 9 frames 3x3, 10-12 frames 4x3, 3x4 or 4x4, 13-16 frames
//   4x4) that must be at most 3840 px a side and 655,360 to 8,294,400 pixels;
// - an SVG needs `svg.model` ("SVG generation requires 'svg.model'.").

const GRIDS: ReadonlyArray<{ readonly upTo: number; readonly grids: ReadonlyArray<readonly [number, number]> }> = [
  { upTo: 8, grids: [[4, 2], [2, 4]] },
  { upTo: 9, grids: [[3, 3]] },
  { upTo: 12, grids: [[4, 3], [3, 4], [4, 4]] },
  { upTo: 16, grids: [[4, 4]] },
]

/** The 400 OpenAI answers for this generations or edits body, or `undefined` when it would make the image. */
export function refusal(body: Readonly<Record<string, unknown>>): Response | undefined {
  if (body.output_format === "svg" && !svgModel(body.svg))
    return error("SVG generation requires 'svg.model'.", "invalid_request_error", "svg.model", "missing_required_parameter")
  if (body.output_format !== "gif") return undefined
  const size = typeof body.size === "string" ? body.size : "auto"
  if (size === "auto") return undefined
  const frames = Number(body.frame_count ?? 9)
  const [width, height] = size.split("x").map(Number) as [number, number]
  const grids = GRIDS.find((entry) => frames <= entry.upTo)?.grids ?? []
  const fits = grids.some(([columns, rows]) => {
    const pixels = columns * width * rows * height
    return Math.max(columns * width, rows * height) <= 3840 && pixels >= 655_360 && pixels <= 8_294_400
  })
  if (fits) return undefined
  return error(`No supported sheet fits ${frames} GIF frames at size '${size}'.`, "image_generation_user_error", "size", "invalid_value")
}

function svgModel(value: unknown) {
  if (typeof value !== "object" || value === null) return false
  const model = (value as { model?: unknown }).model
  return typeof model === "string" && model.length > 0
}

function error(message: string, type: string, param: string, code: string) {
  return Response.json({ error: { message, type, param, code } }, { status: 400 })
}
