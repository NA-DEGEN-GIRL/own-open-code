export * as OwnImportRouting from "./rpc-import-routing.js"

// Plain routing metadata of `own.import` (09 §5.1, §5.5): own-web's first chunk and the phone gateway import these
// tables without evaluating the RPC schema graph, so this file has type-only imports.
import type { OwnImport } from "./rpc-import.js"

type MethodName = OwnImport.MethodName
type EventName = OwnImport.EventName
type Scope = OwnImport.Scope
type Location = OwnImport.Location
type Origin = OwnImport.Origin

export const ID = "own.import"

/**
 * Session metadata key own.import writes on the conversations it imports and on its hidden helper sessions (09 §4.7);
 * own.accounts and own-web read this one key for both. Its value is `OwnImport.Metadata`.
 */
export const META_KEY = "own.import"

/**
 * own.import wrote this session: an imported conversation or a hidden helper (09 §4.2). own.accounts leaves both out
 * of its Z and local-window measurement by the key alone, whatever its value.
 */
export function marked(metadata: Readonly<Record<string, unknown>> | undefined) {
  return metadata?.[META_KEY] !== undefined
}

/**
 * Device scope a method needs (09 §5.5 I2, Q2 decided 2026-10-08). The views and `jobs.list` are `read`: the same
 * user's conversations, limited to own's project folders, and every answer shows secrets by name only (`Redact.named`
 * in the viewer, the search snippets and the list's titles). The migration is `prompt`: it creates a session and uses
 * LLM quota, like sending a message. `sources.configure` names local folders to read, so it stays `local` (the PC's
 * own desktop and web clients only). Skills (09 §9.6): `skills.list` is `read` (names, descriptions and folders of
 * this PC's skills); copying, previewing, installing and checking for updates change this PC's skills folder or use
 * the network, so they are `local`. What one call needs also depends on its input: {@link scopeOf}.
 */
export const MethodScope: { readonly [M in MethodName]: Scope } = {
  health: "read",

  "sources.list": "read",
  "sources.configure": "local",
  "sessions.list": "read",
  "sessions.read": "read",
  "sessions.search": "read",
  "migrate.plan": "prompt",
  "migrate.execute": "prompt",
  "migrate.cancel": "prompt",
  "jobs.list": "read",
  "skills.list": "read",
  "skills.import": "local",
  "skills.preview": "local",
  "skills.install": "local",
  "skills.updates": "local",
  // SM (2026-10-24): it deletes a folder on this PC, like copying one there.
  "skills.remove": "local",
  // SK2 (2026-10-24): a skill's SKILL.md, file names and hash, like the list's names and descriptions.
  "skills.detail": "read",
}

/**
 * The scope one call needs (09 §5.5): the method's ({@link MethodScope}), or `local` for what only this PC's windows
 * may ask. `scope: "all"` on any method reaches every conversation on the PC, outside own's project folders (the
 * `모든 폴더` view and its reads and imports); `redact: false` on `migrate.plan` keeps secrets in the import (IG10);
 * `approvedLinks` on `skills.list` and `skills.detail` reads a folder outside the roots the user approved (SK2), which
 * only this PC's windows may approve. The gateway decides with this, and own-web hides what it refuses.
 */
export function scopeOf(method: MethodName, payload: unknown): Scope {
  if (field(payload, "scope") === "all") return "local"
  if (method === "migrate.plan" && field(payload, "redact") === false) return "local"
  const links = field(payload, "approvedLinks")
  if (Array.isArray(links) && links.length > 0) return "local"
  return MethodScope[method]
}

function field(payload: unknown, name: string): unknown {
  return typeof payload === "object" && payload !== null && name in payload
    ? (payload as Record<string, unknown>)[name]
    : undefined
}

/** Every method goes to the control location (09 §5.2). */
export const MethodLocation: { readonly [M in MethodName]: Location } = {
  health: "control",
  "sources.list": "control",
  "sources.configure": "control",
  "sessions.list": "control",
  "sessions.read": "control",
  "sessions.search": "control",
  "migrate.plan": "control",
  "migrate.execute": "control",
  "migrate.cancel": "control",
  "jobs.list": "control",
  "skills.list": "control",
  "skills.import": "control",
  "skills.preview": "control",
  "skills.install": "control",
  "skills.updates": "control",
  "skills.remove": "control",
  "skills.detail": "control",
}

/** Events carry no conversation content, so every one is `read` (09 §5.3). */
export const EventScope: { readonly [E in EventName]: Scope } = {
  "index.changed": "read",
  "job.progress": "read",
  "job.finished": "read",
}

/**
 * One instance publishes `rpc.own.import.*` events: the control Location's, else the oldest live one while no control
 * instance runs (09 §5.3, 02 §9.1 leader rule); consumers de-duplicate on `eventId`.
 */
export const EventOrigin: { readonly [E in EventName]: Origin } = {
  "index.changed": "global",
  "job.progress": "global",
  "job.finished": "global",
}
