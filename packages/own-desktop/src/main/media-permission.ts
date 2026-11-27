// Voice input's microphone (02 §3.9, 05 §7.8): the shell grants `media` only when every requested medium is audio.
// Camera and screen capture stay refused; the caller also checks that the request comes from the renderer (or, in a
// 원격 PC window, from that PC's app origin). Pure, so the decisions are tested without Electron.

/** `setPermissionRequestHandler`: `media` with `details.mediaTypes` all `audio` (an empty list is not audio). */
export function audioOnlyRequest(permission: string, mediaTypes: ReadonlyArray<string> | undefined) {
  return permission === "media" && !!mediaTypes?.length && mediaTypes.every((type) => type === "audio")
}

/** `setPermissionCheckHandler`: `media` with `details.mediaType` `audio` (never `video` or `unknown`). */
export function audioOnlyCheck(permission: string, mediaType: string | undefined) {
  return permission === "media" && mediaType === "audio"
}
