import type { HttpServerRequest } from "effect/http"

const CAPABILITIES_HEADER = "x-opencode-capabilities"
const MEDIA_URI_CAPABILITY = "experimental-media-uri"

/**
 * Whether the client opted into `media:` refs. The session's own location decides whether its stored media is
 * actually left as refs (`experimental.media_blob`), so this only picks which read to call.
 */
export const wantsMediaRefs = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers[CAPABILITIES_HEADER]?.split(",").some(
    (token) => token.trim().toLowerCase() === MEDIA_URI_CAPABILITY,
  ) ?? false

// OWN-PATCH(P-055) begin
const OMIT_TOOL_FILES_CAPABILITY = "own-omit-tool-file-data"

/**
 * Whether the client asked for message pages without the bytes of tool results' inline files (their `data:` URIs come
 * with an empty payload). own-web asks on transcript pages, in the `own-capabilities` query parameter: a custom header
 * would make every cross-origin page a preflighted request. The capabilities header is read as well.
 */
export const wantsToolFileOmission = (request: HttpServerRequest.HttpServerRequest) =>
  [
    ...new URL(request.url, "http://localhost").searchParams.getAll("own-capabilities"),
    request.headers[CAPABILITIES_HEADER] ?? "",
  ].some((list) => list.split(",").some((token) => token.trim().toLowerCase() === OMIT_TOOL_FILES_CAPABILITY))
// OWN-PATCH(P-055) end
