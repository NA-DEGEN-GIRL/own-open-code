export * as Build from "./build.js"

// Stamped by the release bundler with the same values as the other own plugins (01 §4); see own-accounts `src/build.ts`.
declare const OWN_BUILD_ID: string | undefined
declare const OWN_EXPECTED_APP_VERSION: string | undefined
declare const OWN_PLUGIN_VERSION: string | undefined

export const PLUGIN_ID = "own.import"

/**
 * Keys the process singleton: a desktop bundle is one `index.js` that every Location evaluates again, so state that
 * must outlive that (index, worker, plan nonces, the running job) is shared per build id, and overlapping builds after
 * a hot reload never share it.
 */
export const BUILD_ID = typeof OWN_BUILD_ID === "string" ? OWN_BUILD_ID : "dev"

export const EXPECTED_APP_VERSION = typeof OWN_EXPECTED_APP_VERSION === "string" ? OWN_EXPECTED_APP_VERSION : "local"

export const PLUGIN_VERSION = typeof OWN_PLUGIN_VERSION === "string" ? OWN_PLUGIN_VERSION : "0.0.0-dev"

export const ENV_MARKER = "OWN_OPEN_CODE"
