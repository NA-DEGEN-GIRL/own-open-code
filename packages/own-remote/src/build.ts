export * as Build from "./build.js"

// Stamped by the release bundler with `define` (01 §4, FORK §8.2 step 3). Unbundled source runs (the `local` channel
// and tests) see none of them and use the development values below.
declare const OWN_BUILD_ID: string | undefined
declare const OWN_EXPECTED_APP_VERSION: string | undefined
declare const OWN_PLUGIN_VERSION: string | undefined

export const PLUGIN_ID = "own.remote"

/** Runtime singleton key shared with own-accounts and own-telemetry of the same release (01 §4). */
export const BUILD_ID = typeof OWN_BUILD_ID === "string" ? OWN_BUILD_ID : "dev"

/** The app version this bundle was built for; also the remote version a live connection requires (04 §5.7). */
export const EXPECTED_APP_VERSION = typeof OWN_EXPECTED_APP_VERSION === "string" ? OWN_EXPECTED_APP_VERSION : "local"

export const PLUGIN_VERSION = typeof OWN_PLUGIN_VERSION === "string" ? OWN_PLUGIN_VERSION : "0.0.0-dev"

/** Environment markers (01 §5.4 guard 1, 04 §9.1): a managed local service, and the remote service. */
export const ENV_MARKER = "OWN_OPEN_CODE"
export const ENV_REMOTE = "OWN_REMOTE"
