// Typed server errors screens react to. Only src/data imports @opencode/client at runtime (03 §16.3), so the
// generated guards are wrapped here.
import { isLocationNotFoundError } from "@opencode/client"

/**
 * The server's 404 for a Location whose folder does not exist (upstream 3e1aa1e58c): `GET /api/location`, a prompt
 * or a permission reply in a session whose folder was deleted or moved away. Other failures prove nothing about the
 * folder.
 */
export function isLocationMissing(error: unknown) {
  return isLocationNotFoundError(error)
}
