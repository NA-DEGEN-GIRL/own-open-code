import fs from "node:fs/promises"

/** The errors Node's `fs.rm` retries: on Windows a file another process holds for a moment answers one of them. */
const RETRIED: ReadonlySet<string> = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"])

/**
 * `fs.rm(target, {recursive, force})` with the retries Node's `maxRetries`/`retryDelay` give. Bun accepts those options
 * but does not retry (1.4.2 on Windows fails an `EBUSY` within a millisecond), so a test teardown that relied on them
 * failed whenever the indexer or Defender held a file the test had just written.
 */
export async function removeTree(target: string, attempts = 20, delayMs = 100): Promise<void> {
  const failure = await fs.rm(target, { recursive: true, force: true }).then(
    () => undefined,
    (error: NodeJS.ErrnoException) => error,
  )
  if (failure === undefined) return
  if (attempts <= 1 || !RETRIED.has(failure.code ?? "")) throw failure
  await Bun.sleep(delayMs)
  return removeTree(target, attempts - 1, delayMs)
}
