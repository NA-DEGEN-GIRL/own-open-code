// Browser tool policy of web-mode sessions (01 §10.1 "도구 목록 규칙", 05 §8.7 plan D, 01 §17.1 #5).
// Facts from core: `opencode.browser` registers its tools in every service, as Code Mode tools with the permission
// name `browser` (`packages/plugin-browser/src/tools.ts:49-50`). Since v2.0.24 (82bb5ff88a) every agent ends with the
// plugin's `browser * deny` and a desktop attachment appends `browser * allow` to the session's rules while it lasts
// (`connection.ts` `grant`), so the catalog lists the tools only while a desktop is attached; a call after a detach
// fails at once with `[browser.disconnected]`. A session rule `{action: "browser", resource: "*", effect: "deny"}`
// drops the tools from the session's snapshot and its Code Mode catalog (`packages/core/src/tool.ts:229-232,
// 292-295`); the request's tool definitions stay the same (only `execute` is listed).
// Rules:
// 1. A session created where no desktop is there to hold its browser pane gets that deny **at creation**, so its
//    catalog never lists browser tools. "There" (`browserPaneHeld`) is a window with `capabilities.browserPane`, and
//    since 05 §8.10.5 also a paired device while the PC's desktop app is running: the gateway asks that app to attach
//    the session before it relays the device's prompt. The web fallback, and a device whose PC has no desktop app
//    running (or has not answered yet), add the deny; a window with the pane adds nothing.
// 2. An existing session is never changed because the window kind changed (no silent mid-session flip): opening a
//    desktop session on the web keeps its rules (no desktop attached, so no browser tools listed) and the UI explains.
//    A desktop window never attaches a session that has the rule 1 deny, since the attachment's allow would win.
// 3. Turning it on later is an explicit action per session (05 §8.7 rule 3): the pane's [이 세션에서 켜기] calls
//    `session.approval.set{browserTool:"on"}` through the local server's writer (browser/enable.ts, registered by
//    browser/attach.tsx; session rules are written only by `session.approval.set`, 03 §16.3).
// 4. Children copy the parent's rules at creation (`packages/core/src/session.ts:273-276`).
// Pure functions, unit-tested in policy.test.ts.
import type { PermissionRule } from "@opencode/client"
import type { HostCapabilities } from "@/host"
import type { HostRemotePane } from "@/host/types"

export const BROWSER_ACTION = "browser"
export const BROWSER_DENY: PermissionRule = { action: BROWSER_ACTION, resource: "*", effect: "deny" }
/**
 * The allow the browser plugin appends to a session's rules while a desktop is attached and removes on release
 * (upstream 82bb5ff88a, `packages/plugin-browser/src/connection.ts` `grant`). own.accounts' mode reading steps over it.
 */
export const BROWSER_ATTACH_ALLOW: PermissionRule = { action: BROWSER_ACTION, resource: "*", effect: "allow" }

export function sameRule(a: PermissionRule, b: PermissionRule) {
  return a.action === b.action && a.resource === b.resource && a.effect === b.effect
}
const DISCONNECTED = "[browser.disconnected]"

/** What of the host the rules read; `remotePane` is there on a paired device only (05 §8.10.5). */
export interface BrowserHost {
  readonly capabilities: Pick<HostCapabilities, "browserPane">
  readonly remotePane?: HostRemotePane
}

/**
 * Rule 1's "a desktop is there to hold the browser pane": this window has the pane, or this is a paired device and the
 * PC's desktop app is running as far as the device knows (`false` while it has no answer).
 */
export function browserPaneHeld(host: BrowserHost) {
  return host.capabilities.browserPane || host.remotePane?.available() === true
}

/**
 * Rule 1: the `permissions` a brand-new session is created with (empty where the pane is held). `capabilities` is the
 * window's, or `{browserPane: browserPaneHeld(host)}` where a device may create sessions (the composer).
 */
export function browserCreationRules(capabilities: Pick<HostCapabilities, "browserPane">): PermissionRule[] {
  return capabilities.browserPane ? [] : [{ ...BROWSER_DENY }]
}

/**
 * A session-create input with rule 1 applied. The browser deny goes last among rules that match `browser`, because
 * core looks only at the last rule whose action matches (`whollyDisabled`). Not for a hand-over that copies the
 * source session's rules as they are (03 §16.3 exception): the source's own policy travels with them.
 */
export function withBrowserPolicy<
  T extends { readonly permissions?: readonly PermissionRule[] | null; readonly [key: string]: unknown },
>(input: T, capabilities: Pick<HostCapabilities, "browserPane">): T {
  const extra = browserCreationRules(capabilities)
  if (!extra.length) return input
  return { ...input, permissions: [...(input.permissions ?? []), ...extra] }
}

/** Core's wildcard (`packages/core/src/util/wildcard.ts`), case-insensitive as on the Windows service. */
export function wildcardMatch(input: string, pattern: string) {
  const escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  const tail = escaped.endsWith(" .*") ? `${escaped.slice(0, -3)}( .*)?` : escaped
  return new RegExp(`^${tail}$`, "si").test(input.replaceAll("\\", "/"))
}

/** Core's `whollyDisabled("browser", rules)`: the last rule whose action matches is a `"*"` deny. */
export function browserRemoved(rules: readonly PermissionRule[] | undefined) {
  const last = (rules ?? []).findLast((rule) => wildcardMatch(BROWSER_ACTION, rule.action))
  return last?.resource === "*" && last.effect === "deny"
}

/**
 * - `removed`: the session started without browser tools (rule 1), whatever window shows it.
 * - `no-pane`: the tools are in the session's catalog but no desktop holds its pane from here (the web fallback; a
 *   device whose PC has no desktop app running); calls fail fast.
 * - `available`: tools listed and the pane is held (`browserPaneHeld`).
 */
export type BrowserToolState = "removed" | "no-pane" | "available"

export function browserToolState(
  rules: readonly PermissionRule[] | undefined,
  capabilities: Pick<HostCapabilities, "browserPane">,
): BrowserToolState {
  if (browserRemoved(rules)) return "removed"
  return capabilities.browserPane ? "available" : "no-pane"
}

/** A browser tool result that failed because no desktop browser is attached (03 §8 "브라우저 없음"). */
export function isBrowserDisconnected(output: string | undefined) {
  return output?.trimStart().startsWith(DISCONNECTED) ?? false
}

/**
 * 03 §8: the line under such a tool card. The two `own.browser.*` keys are the shared catalog's (src/i18n); a paired
 * device gets the policy catalog's line instead (strings.ts), since there the PC's desktop app holds the browser and
 * "only in the desktop app" would be wrong.
 */
export function browserDisconnectedHint(host: BrowserHost) {
  if (host.capabilities.browserPane) return "own.browser.notAttached" as const
  return host.remotePane ? ("own.policy.browser.needDesktop" as const) : ("own.browser.onlyDesktop" as const)
}
