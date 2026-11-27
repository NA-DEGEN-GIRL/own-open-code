export * as GitHubBridge from "./github-bridge.js"

/**
 * What own-accounts' GitHub connection (16 §6, GH) offers the other own plugins of this process: the environment a
 * git or gh process they start needs to use the GitHub account chosen for its folder. own-team's 원격에 올리기 (06 §7.5)
 * asks it before `git push`, `git lfs push` and `gh pr create`. Plugin modules are imported again per Location and per
 * plugin bundle, so the provider lives on `globalThis` (as `Runtime` and `LogFile` do); the newest provider answers.
 */
export interface Provider {
  /**
   * The variables to add to a git process's environment in `directory`: git's credential helper for the account's
   * host through own (never the token itself), and with `gh` also `GH_TOKEN` (or `GH_ENTERPRISE_TOKEN` and `GH_HOST`)
   * for a gh process own starts itself. `undefined` when no account applies there: the process keeps the user's own
   * git and gh logins.
   */
  readonly gitEnv: (directory: string, options?: Options) => Promise<Readonly<Record<string, string>> | undefined>
}

export interface Options {
  /** The process also runs gh (own's own `gh pr create`): add gh's token variable. Never for an agent's shell. */
  readonly gh?: boolean
  /** The conversation the process belongs to, so its own choice applies (a harness's shell). */
  readonly sessionID?: string
  /**
   * Ends the process's git login (its ticket) when it aborts: abort it once the process exited. Without it the login
   * ends after an hour.
   */
  readonly signal?: AbortSignal
  /**
   * The id of the process started with these variables, once it is spawned (`undefined` when it was not). On an SSH
   * host the git login then works for that process alone (16 §8.6, GH-48): a process that copies its variables and
   * starts itself again with them is refused. Without it the first process to use the login keeps it.
   */
  readonly pid?: Promise<number | undefined>
}

const KEY = Symbol.for("own-open-code.github-bridge")

/** Makes `provider` the one {@link gitEnv} asks; the result takes it back (an older one answers again). */
export function provide(provider: Provider) {
  const list = providers()
  list.push(provider)
  return () => {
    const index = list.lastIndexOf(provider)
    if (index >= 0) list.splice(index, 1)
  }
}

/** The newest provider's answer, or `undefined` when none is there (own-accounts not loaded, a remote service). */
export async function gitEnv(directory: string, options: Options = {}) {
  const provider = providers().at(-1)
  if (!provider) return undefined
  return provider.gitEnv(directory, options).catch(() => undefined)
}

function providers() {
  // The process-wide list lives on globalThis by design, like the runtime singleton (01 §4).
  const holder = globalThis as unknown as Record<symbol, Provider[] | undefined>
  const existing = holder[KEY]
  if (existing) return existing
  const created: Provider[] = []
  holder[KEY] = created
  return created
}
