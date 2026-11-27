// Test support (unit tests that make temp folders; never imported by the app).
import fs from "node:fs/promises"
import path from "node:path"

/** The errors Node's `fs.rm` retries: on Windows a file another process holds for a moment answers one of them. */
const RETRIED: ReadonlySet<string> = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"])

/**
 * `fs.rm(target, {recursive, force})` with the retries Node's `maxRetries`/`retryDelay` give. Bun accepts those options
 * but does not retry (1.4.2 on Windows fails an `EBUSY` within a millisecond), so a test teardown that relied on them
 * failed whenever the indexer or Defender held a file the test had just written.
 */
export async function removeTree(target: string, attempts = 20, delayMs = 100): Promise<void> {
  // A teardown whose setup failed passed "" here (git.test.ts with a TEMP that did not exist, 2026-11-20): `fs.rm("")`
  // removed the working directory, the whole package. Only an absolute path is removed.
  if (!path.isAbsolute(target)) throw new Error(`removeTree: not an absolute path: ${JSON.stringify(target)}`)
  const failure = await fs.rm(target, { recursive: true, force: true }).then(
    () => undefined,
    (error: NodeJS.ErrnoException) => error,
  )
  if (failure === undefined) return
  if (attempts <= 1 || !RETRIED.has(failure.code ?? "")) throw failure
  await Bun.sleep(delayMs)
  return removeTree(target, attempts - 1, delayMs)
}
