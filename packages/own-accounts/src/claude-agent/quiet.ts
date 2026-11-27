export * as ClaudeQuiet from "./quiet.js"

/**
 * Claude Code's telemetry, error reports, remote feature flags, feedback upload and surveys off in every claude own
 * starts (decisions TLM): the login window, the update card's `claude --version` and `claude update`. The same values
 * as core's `ClaudeIO.QUIET` (P-042) for the route's chats and checks; own-accounts is another bundle, so they are kept
 * here too (own/scripts/test/telemetry-off.test.ts pins both). Not CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: it also
 * skips the subscription's model bootstrap, the quota probe and the update check `claude update` needs.
 */
export const FLAGS = {
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DO_NOT_TRACK: "1",
  DISABLE_GROWTHBOOK: "1",
  DISABLE_BUG_COMMAND: "1",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
} as const

/**
 * Windows' process start (libuv, in Node and Bun alike) copies USERNAME, USERDOMAIN and LOGONSERVER from the service into
 * a child environment that lacks them; empty values keep them and the PC's name out.
 */
export const ANONYMOUS = {
  USERNAME: "",
  USERDOMAIN: "",
  LOGONSERVER: "",
  COMPUTERNAME: "",
} as const
