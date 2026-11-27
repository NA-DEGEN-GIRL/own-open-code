export * as Location from "./location.js"

import path from "node:path"

/** Whether two directories are the same Location. Windows paths compare case-insensitively. */
export function same(a: string, b: string) {
  return key(a) === key(b)
}

/** Whether `directory` is `root` or a folder inside it. Windows paths compare case-insensitively. */
export function within(directory: string, root: string) {
  const inner = key(directory)
  const outer = key(root)
  return inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep)
}

/** A folder as {@link same} and {@link within} compare it: resolved (`/` becomes `\` on Windows), case folded there. */
function key(value: string) {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}
