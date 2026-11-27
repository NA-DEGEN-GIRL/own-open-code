import { describe, expect, test } from "bun:test"
import type { PermissionRule } from "@opencode/client"
import {
  BROWSER_DENY,
  browserCreationRules,
  browserDisconnectedHint,
  browserPaneHeld,
  browserRemoved,
  browserToolState,
  isBrowserDisconnected,
  wildcardMatch,
  withBrowserPolicy,
  type BrowserHost,
} from "./browser"
import { browserNoticeKey } from "./notice"
import { browserPolicyLine, panelEn, panelKo, panelText } from "./panel"
import { policyEn, policyKo, policyText } from "./strings"

const web = { browserPane: false }
const desktop = { browserPane: true }
// The three kinds of host (05 §8.10.5): the PC's desktop window, the web fallback, and a paired device, whose host
// carries `remotePane` with the last answer of own.remote `browser.status`.
const desktopHost: BrowserHost = { capabilities: desktop }
const webHost: BrowserHost = { capabilities: web }
const device = (available: boolean): BrowserHost => ({ capabilities: web, remotePane: { available: () => available } })

describe("browser tool policy (01 §10.1, 05 §8.7 plan D)", () => {
  test("rule 1: a window without the pane creates sessions with the browser deny; the desktop adds nothing", () => {
    expect(browserCreationRules(web)).toEqual([{ action: "browser", resource: "*", effect: "deny" }])
    expect(browserCreationRules(desktop)).toEqual([])
    expect(withBrowserPolicy({ title: "x" }, desktop)).toEqual({ title: "x" })
    const allow: PermissionRule[] = [{ action: "browser", resource: "*", effect: "allow" }]
    expect(withBrowserPolicy({ title: "x", permissions: allow }, web)).toEqual({
      title: "x",
      permissions: [
        { action: "browser", resource: "*", effect: "allow" },
        { action: "browser", resource: "*", effect: "deny" },
      ],
    })
  })

  test("the deny is a '*' deny (tool removed from the catalog), not the '**' deny approval modes use", () => {
    expect(BROWSER_DENY.resource).toBe("*")
    expect(browserRemoved([{ action: "browser", resource: "**", effect: "deny" }])).toBe(false)
    expect(browserRemoved([BROWSER_DENY])).toBe(true)
  })

  test("the last rule whose action matches decides, as core's whollyDisabled does", () => {
    expect(browserRemoved(undefined)).toBe(false)
    expect(browserRemoved([BROWSER_DENY, { action: "*", resource: "*", effect: "allow" }])).toBe(false)
    expect(browserRemoved([{ action: "*", resource: "*", effect: "allow" }, BROWSER_DENY])).toBe(true)
    expect(browserRemoved([{ action: "brow*", resource: "*", effect: "deny" }])).toBe(true)
    // own-accounts' approval bundles never name `browser`, so they keep the creation rule in force.
    expect(
      browserRemoved([
        BROWSER_DENY,
        { action: "edit", resource: "**", effect: "deny" },
        { action: "shell", resource: "**", effect: "deny" },
        { action: "read", resource: "C:/own/vault/**", effect: "deny" },
      ]),
    ).toBe(true)
    expect(wildcardMatch("browser", "Browser")).toBe(true)
    expect(wildcardMatch("webfetch", "web?etch")).toBe(true)
    expect(wildcardMatch("bash ls -la", "bash ls *")).toBe(true)
    expect(wildcardMatch("bash ls", "bash ls *")).toBe(true)
  })

  test("rule 2: states never flip the session; they only describe it in the current window", () => {
    expect(browserToolState([BROWSER_DENY], desktop)).toBe("removed")
    expect(browserToolState([BROWSER_DENY], web)).toBe("removed")
    expect(browserToolState([], web)).toBe("no-pane")
    expect(browserToolState(undefined, desktop)).toBe("available")
  })

  test("a disconnected tool result gets the 03 §8 hint for this window", () => {
    expect(isBrowserDisconnected("[browser.disconnected] No desktop browser is connected to this session.")).toBe(true)
    expect(isBrowserDisconnected("  [browser.disconnected] x")).toBe(true)
    expect(isBrowserDisconnected("Browser is unavailable.")).toBe(false)
    expect(isBrowserDisconnected(undefined)).toBe(false)
    expect(browserDisconnectedHint(webHost)).toBe("own.browser.onlyDesktop")
    expect(browserDisconnectedHint(desktopHost)).toBe("own.browser.notAttached")
    // A paired device: the browser is the PC's desktop app's, so "only in the desktop app" would be wrong there.
    expect(browserDisconnectedHint(device(false))).toBe("own.policy.browser.needDesktop")
    expect(browserDisconnectedHint(device(true))).toBe("own.policy.browser.needDesktop")
    expect(policyText("ko", "own.policy.browser.needDesktop")).toBe(
      "PC의 데스크톱 앱이 켜져 있어야 에이전트가 브라우저를 쓸 수 있어요.",
    )
  })

  test("rule 1 on a paired device (05 §8.10.5): no deny while the PC's desktop app runs, the deny otherwise", () => {
    const input: { readonly title: string; readonly permissions?: PermissionRule[] } = { title: "x" }
    const created = (host: BrowserHost) => withBrowserPolicy(input, { browserPane: browserPaneHeld(host) })
    // The desktop window: the pane is its own.
    expect(browserPaneHeld(desktopHost)).toBe(true)
    expect(created(desktopHost)).toBe(input)
    // A device whose PC runs the desktop app: nothing added, so the gateway's attach before the prompt gives the tools.
    expect(browserPaneHeld(device(true))).toBe(true)
    expect(created(device(true))).toBe(input)
    // A device whose PC has no desktop app running, or has not answered yet; and the web fallback: today's deny.
    expect(browserPaneHeld(device(false))).toBe(false)
    expect(created(device(false))).toEqual({ title: "x", permissions: [BROWSER_DENY] })
    expect(browserPaneHeld(webHost)).toBe(false)
    expect(created(webHost)).toEqual({ title: "x", permissions: [BROWSER_DENY] })
    // Both shapes are the only ones the gateway lets a device create with (own-remote `deviceRules`).
    expect(created(device(false)).permissions).toEqual([{ action: "browser", resource: "*", effect: "deny" }])
  })

  test("the notice says what is true on each host", () => {
    // New-session screen.
    expect(browserNoticeKey(desktopHost, undefined)).toBeUndefined()
    expect(browserNoticeKey(webHost, undefined)).toBe("own.policy.browser.newWeb")
    expect(browserNoticeKey(device(true), undefined)).toBeUndefined()
    expect(browserNoticeKey(device(false), undefined)).toBe("own.policy.browser.needDesktop")
    // A session whose catalog has the tools: the state is read with `browserPaneHeld`, as the notice does.
    const state = (host: BrowserHost, rules: PermissionRule[]) => ({
      state: browserToolState(rules, { browserPane: browserPaneHeld(host) }),
    })
    expect(browserNoticeKey(desktopHost, state(desktopHost, []))).toBeUndefined()
    expect(browserNoticeKey(webHost, state(webHost, []))).toBe("own.policy.browser.openInDesktop")
    expect(browserNoticeKey(device(true), state(device(true), []))).toBeUndefined()
    expect(browserNoticeKey(device(false), state(device(false), []))).toBe("own.policy.browser.needDesktop")
    // A session that started without them: the desktop and a device say so (each with its own way to turn them on);
    // the web fallback has no way to offer and stays silent, as before.
    expect(browserNoticeKey(desktopHost, state(desktopHost, [BROWSER_DENY]))).toBe("own.policy.browser.startedWithout")
    expect(browserNoticeKey(device(true), state(device(true), [BROWSER_DENY]))).toBe(
      "own.policy.browser.startedWithout",
    )
    expect(browserNoticeKey(device(false), state(device(false), [BROWSER_DENY]))).toBe(
      "own.policy.browser.startedWithout",
    )
    expect(browserNoticeKey(webHost, state(webHost, [BROWSER_DENY]))).toBeUndefined()
    // Not loaded yet: nothing.
    expect(browserNoticeKey(device(false), { state: undefined })).toBeUndefined()
    expect(policyText("ko", "own.policy.browser.enableInViewer")).toBe("대화의 ⋯ > 브라우저에서 켤 수 있어요.")
    expect(Object.keys(policyKo).filter((key) => !(key in policyEn))).toEqual([])
  })

  test("panel lines", () => {
    expect(panelText("ko", browserPolicyLine(undefined, webHost))).toBe("이 창에서 만드는 대화: 브라우저 도구 없음")
    expect(browserPolicyLine("removed", desktopHost)).toBe("own.policy.browser.sessionOff")
    expect(browserPolicyLine("no-pane", webHost)).toBe("own.policy.browser.sessionNoPane")
    expect(browserPolicyLine("available", desktopHost)).toBe("own.policy.browser.sessionOn")
    expect(browserPolicyLine(undefined, desktopHost)).toBe("own.policy.browser.windowOn")
    // A paired device reads as the PC's desktop app does while that runs, and names the app when it does not.
    expect(browserPolicyLine(undefined, device(true))).toBe("own.policy.browser.windowOn")
    expect(browserPolicyLine(undefined, device(false))).toBe("own.policy.browser.windowOff")
    expect(panelText("ko", browserPolicyLine("no-pane", device(false)))).toBe(
      "이 대화: 브라우저 도구 있음 — PC의 데스크톱 앱이 켜져 있어야 동작함",
    )
    expect(browserPolicyLine("removed", device(true))).toBe("own.policy.browser.sessionOff")
  })

  test("the popover's lines are their own catalog, so the first chunk's catalog does not carry them (PF5)", () => {
    expect(Object.keys(panelKo).toSorted()).toEqual(Object.keys(panelEn).toSorted())
    expect(Object.keys(panelKo).filter((key) => key in policyKo)).toEqual([])
  })
})
