export * as Build from "./build.js"

// Stamped by the release bundler with `define` (01 §4 "싱글턴 규칙", §5.4 guard 1). Unbundled source runs (the
// `local` channel and tests) see none of them and use the development values below.
declare const OWN_BUILD_ID: string | undefined
declare const OWN_EXPECTED_APP_VERSION: string | undefined
declare const OWN_PLUGIN_VERSION: string | undefined

export const PLUGIN_ID = "own.accounts"

/**
 * Runtime singleton key shared by the own-accounts and own-telemetry bundles of one release. Source runs share
 * `"dev"`; the plugin option `buildId` overrides it (tests), and must then be the same for both plugins.
 */
export const BUILD_ID = typeof OWN_BUILD_ID === "string" ? OWN_BUILD_ID : "dev"

/** The upstream app version this bundle was built against. A source server reports `"local"` (`cli/src/version.ts`). */
export const EXPECTED_APP_VERSION = typeof OWN_EXPECTED_APP_VERSION === "string" ? OWN_EXPECTED_APP_VERSION : "local"

/** Reported by `health.version` and `health.pluginVersions.accounts`. */
export const PLUGIN_VERSION = typeof OWN_PLUGIN_VERSION === "string" ? OWN_PLUGIN_VERSION : "0.0.0-dev"

/** Environment marker the launcher sets for a managed service (01 §5.4 guard 1). */
export const ENV_MARKER = "OWN_OPEN_CODE"

/** Environment marker of a remote service's managed env (04 §5.6, §9.1 guard 1 of `mode:"remote"`). */
export const ENV_REMOTE = "OWN_REMOTE"
