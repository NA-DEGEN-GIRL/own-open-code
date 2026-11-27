export * as Build from "./build.js"

// Stamped by the release bundler with `define` (01 §4, FORK §8.2 step 3), with the same values as the other own
// plugins of the release (own-accounts `src/build.ts`). Unbundled source runs (the `local` channel and tests) see none
// of them and use the development values below.
declare const OWN_BUILD_ID: string | undefined
declare const OWN_EXPECTED_APP_VERSION: string | undefined
declare const OWN_PLUGIN_VERSION: string | undefined

/** Plugin id and RPC id (06 §2.6, §12.2). */
export const PLUGIN_ID = "own.team"

/** Keys the process singletons, so instances of one build share the controller and overlapping builds never do. */
export const BUILD_ID = typeof OWN_BUILD_ID === "string" ? OWN_BUILD_ID : "dev"

/** The upstream app version this bundle was built against. A source server reports `"local"` (`cli/src/version.ts`). */
export const EXPECTED_APP_VERSION = typeof OWN_EXPECTED_APP_VERSION === "string" ? OWN_EXPECTED_APP_VERSION : "local"

/** Reported by `health.version`. */
export const PLUGIN_VERSION = typeof OWN_PLUGIN_VERSION === "string" ? OWN_PLUGIN_VERSION : "0.0.0-dev"

/** Environment marker the launcher sets for a managed service (01 §5.4 guard 1). */
export const ENV_MARKER = "OWN_OPEN_CODE"

/** Environment marker of a remote service's managed env (04 §9.1); required by `mode: "remote"`. */
export const ENV_REMOTE = "OWN_REMOTE"

/** Tool namespace: core names the tools `team_<name>` (06 §2.8). */
export const NAMESPACE = "team"

/** Seconds the process-lifetime controller outlives its last reference (06 §2.6). */
export const LINGER_SECONDS = 30
