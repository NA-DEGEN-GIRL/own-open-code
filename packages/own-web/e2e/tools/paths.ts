// The tools suite's temp files (SM 2026-10-24), shared by backend.ts and teardown.ts without starting anything.
import path from "node:path"
import { checkoutTmp } from "../gateway/support"

/** Set by playwright.config.ts (the backend runs with TEMP pointed there). */
export const TOOLS_TMP = process.env.OWN_WEB_TOOLS_E2E_TMP ?? checkoutTmp("own-web-tools-e2e")
export const STATE_FILE = path.join(TOOLS_TMP, "backend.json")
/** Written by teardown.ts: the backend stops and cleans up. */
export const STOP_FILE = path.join(TOOLS_TMP, "stop")
/** The team harness names its temp root after this (`own-team-e2e-<NAME>-…`). */
export const NAME = "web-tools"
/** The fake home of the other tools (Codex, Claude Code). */
export const HOME = path.join(TOOLS_TMP, "tool-home")
