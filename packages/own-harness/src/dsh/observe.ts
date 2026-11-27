// Ports packages/fs/fs-observation-policy/src/index.ts: what a session has seen of each file, so `write` replaces only a
// file read at its current version, `edit` edits only a file it read, and both fail with dsh's remedy otherwise. dsh
// keeps this in memory per live session object; own keeps it per session id in the plugin process, so it is gone after
// a restart as it is after a dsh resume. A version is dsh's `dev:ino:size:mtimeNs:ctimeNs` (fs-local `versionOf`).
// Ported from deepseek-ai/deepseek-harness (MIT, Copyright (c) 2026 DeepSeek) @ 687f282e86; see dsh-data/NOTICE.
export * as DshObserve from "./observe.js"

import { stat } from "node:fs/promises"

export type Observation = { readonly kind: "present"; readonly version: string } | { readonly kind: "absent" }

/** `FsError` codes the tools route on; the message is what the model reads, the cause what failed underneath. */
export class FsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** Sessions whose observations are kept; the oldest go first. */
const SESSIONS = 256

export class State {
  private readonly sessions = new Map<string, Map<string, Observation>>()

  observe(sessionID: string, key: string, observation: Observation) {
    const files = this.sessions.get(sessionID) ?? new Map<string, Observation>()
    this.sessions.delete(sessionID)
    this.sessions.set(sessionID, files.set(key, observation))
    if (this.sessions.size > SESSIONS) this.sessions.delete(this.sessions.keys().next().value!)
  }

  /** `writeIntent`: a file seen present is replaced only at that version; anything else is created only if absent. */
  writeIntent(sessionID: string, key: string) {
    const prior = this.sessions.get(sessionID)?.get(key)
    return prior?.kind === "present"
      ? ({ kind: "replaceIfVersion", version: prior.version } as const)
      : ({ kind: "createIfAbsent" } as const)
  }

  /** `editIntent`: the observed version, or dsh's refusal for a file not read or seen absent. */
  editIntent(sessionID: string, key: string, displayPath: string) {
    const prior = this.sessions.get(sessionID)?.get(key)
    if (prior === undefined) throw new FsError(`edit requires reading "${displayPath}" first`, "FS_NOT_OBSERVED")
    if (prior.kind === "absent") throw new FsError(`cannot edit "${displayPath}": not found`, "FS_NOT_FOUND")
    return prior.version
  }

  forget(sessionID: string) {
    this.sessions.delete(sessionID)
  }
}

/** `probe`: the file's version and type, or undefined when it does not exist. */
export async function probe(file: string) {
  const info = await stat(file, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined
    throw error
  })
  if (info === undefined) return undefined
  return {
    version: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
    file: info.isFile(),
    size: Number(info.size),
  }
}

/** `remediateFsError`: the guarded-mutation failures with dsh's model-facing remedy. */
export function remediate(error: unknown, displayPath: string) {
  if (!(error instanceof FsError)) return error
  if (error.code === "FS_NOT_OBSERVED")
    return new FsError(`cannot modify "${displayPath}": file has not been read — read the file, then retry`, error.code)
  if (error.code === "FS_STALE_VERSION")
    return new FsError(`${error.message} — re-read the file, then retry`, error.code)
  return error
}
