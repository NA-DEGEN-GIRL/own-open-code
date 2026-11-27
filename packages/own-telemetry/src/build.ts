export * as Build from "./build.js"

// Stamped by the release bundler with the same values as own-accounts (01 §4); see own-accounts `src/build.ts`.
declare const OWN_BUILD_ID: string | undefined
declare const OWN_EXPECTED_APP_VERSION: string | undefined
declare const OWN_PLUGIN_VERSION: string | undefined

export const PLUGIN_ID = "own.telemetry"

/** Must equal own-accounts' build id so both plugins share one runtime singleton. */
export const BUILD_ID = typeof OWN_BUILD_ID === "string" ? OWN_BUILD_ID : "dev"

export const EXPECTED_APP_VERSION = typeof OWN_EXPECTED_APP_VERSION === "string" ? OWN_EXPECTED_APP_VERSION : "local"

export const PLUGIN_VERSION = typeof OWN_PLUGIN_VERSION === "string" ? OWN_PLUGIN_VERSION : "0.0.0-dev"

export const ENV_MARKER = "OWN_OPEN_CODE"

/** The only provider this plugin observes: the third-party Claude subscription slot (02 §8, R-ID-4). */
export const PROVIDER_ID = "anthropic"

/** Synthetic account id of the Claude slot; every `claude.*` window uses it (02 §8.5). */
export const CLAUDE_ACCOUNT_ID = "acc_claude_slot"
