export * as Build from "./build.js"

// Stamped by the release bundler with the same values as the other own plugins (01 §4); see own-accounts `src/build.ts`.
declare const OWN_BUILD_ID: string | undefined
declare const OWN_EXPECTED_APP_VERSION: string | undefined
declare const OWN_PLUGIN_VERSION: string | undefined

export const PLUGIN_ID = "own.computer-use"

/** Keys the process singleton, so instances of one build share the helper and overlapping builds never do. */
export const BUILD_ID = typeof OWN_BUILD_ID === "string" ? OWN_BUILD_ID : "dev"

export const EXPECTED_APP_VERSION = typeof OWN_EXPECTED_APP_VERSION === "string" ? OWN_EXPECTED_APP_VERSION : "local"

export const PLUGIN_VERSION = typeof OWN_PLUGIN_VERSION === "string" ? OWN_PLUGIN_VERSION : "0.0.0-dev"

export const ENV_MARKER = "OWN_OPEN_CODE"

/** Tool namespace and the permission action of every computer tool. */
export const NAMESPACE = "computer"

/** File name of the Windows helper next to the app (`app\<version>\own-cu-helper.exe`). */
export const HELPER_EXE = "own-cu-helper.exe"
