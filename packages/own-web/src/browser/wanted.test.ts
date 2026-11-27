// Panes a paired device asks for (05 §8.10.4) over the window's real attachment registry and the real rule check,
// with a fake pane platform, a fake session store per server and a fake `browser.pane.wanted` answer.
import { describe, expect, test } from "bun:test"
import type { PermissionRule } from "@opencode/client"
import { BROWSER_DENY, browserRemoved } from "@/policy/browser"
import { createBrowserAttachments } from "./attachments"
import type { BrowserPanePlatform } from "./types"
import { createWantedPanes, type WantedPane } from "./wanted"

const LOCAL = "local"
const HOST = "h-abc123"
const local = (sessionID: string): WantedPane => ({ serverKey: LOCAL, sessionID })
const key = (pane: WantedPane) => `${pane.serverKey}/${pane.sessionID}`

function setup(options: { readonly endpoint?: boolean; readonly hostConnected?: boolean } = {}) {
  const registered: string[] = []
  const platform: BrowserPanePlatform = {
    platform: "desktop",
    register(target) {
      registered.push(`${target.serverKey}/${target.sessionID}`)
      return { setLayout() {}, command: async () => {}, capture: async () => null, close() {} }
    },
  }
  const attachments = createBrowserAttachments({
    platform,
    endpoint: (serverKey) => {
      if (options.endpoint === false) return undefined
      if (serverKey === LOCAL) return { url: "http://127.0.0.1:1" }
      return options.hostConnected === false
        ? undefined
        : { url: "http://127.0.3.2:24817", username: "opencode", password: "t" }
    },
  })
  /** What the servers hold, and what this window has loaded of it, by `server/session`. */
  const service = new Map<string, readonly PermissionRule[]>()
  const loaded = new Map<string, readonly PermissionRule[]>()
  const reads: string[] = []
  const calls = { wanted: 0 }
  const answer: { list: readonly WantedPane[]; fail: boolean } = { list: [], fail: false }
  const panes = createWantedPanes({
    wanted: async () => {
      calls.wanted += 1
      if (answer.fail) throw new Error("own.scope_denied")
      return answer.list
    },
    known: (pane) => loaded.has(key(pane)),
    load: async (pane) => {
      reads.push(key(pane))
      const rules = service.get(key(pane))
      if (!rules) throw new Error("session_not_found")
      loaded.set(key(pane), rules)
    },
    attachable: (pane) => loaded.has(key(pane)) && !browserRemoved(loaded.get(key(pane))),
    attach: (pane) => attachments.ensure(pane.serverKey, pane.sessionID)?.wake(),
  })
  return { panes, attachments, registered, service, loaded, reads, calls, answer }
}

describe("panes a device asks for (05 §8.10.4)", () => {
  test("the event attaches and wakes a session this window knows", async () => {
    const fx = setup()
    fx.loaded.set("local/ses_1", [])
    await fx.panes.want(local("ses_1"))
    expect(fx.attachments.get(LOCAL, "ses_1")).toBeDefined()
    expect(fx.registered).toEqual(["local/ses_1"])
    expect(fx.reads).toEqual([])
  })

  test("a session another client just created is read first, then attached", async () => {
    const fx = setup()
    fx.service.set("local/ses_new", [{ action: "edit", resource: "**", effect: "deny" }])
    await fx.panes.want(local("ses_new"))
    expect(fx.reads).toEqual(["local/ses_new"])
    expect(fx.registered).toEqual(["local/ses_new"])
  })

  test("a session whose rules deny the browser is never attached, known or just read", async () => {
    const fx = setup()
    fx.loaded.set("local/ses_off", [BROWSER_DENY])
    fx.service.set("local/ses_off2", [BROWSER_DENY])
    await fx.panes.want(local("ses_off"))
    await fx.panes.want(local("ses_off2"))
    expect(fx.reads).toEqual(["local/ses_off2"])
    expect(fx.attachments.list()).toEqual([])
    expect(fx.registered).toEqual([])
    // Asked again (the hub repeats every 5 s): a known session is not read again.
    await fx.panes.want(local("ses_off2"))
    expect(fx.reads).toEqual(["local/ses_off2"])
  })

  test("a session that cannot be read is left alone", async () => {
    const fx = setup()
    await fx.panes.want(local("ses_gone"))
    expect(fx.reads).toEqual(["local/ses_gone"])
    expect(fx.attachments.list()).toEqual([])
  })

  test("start and every reconnect read the list again; the same session twice is one attachment", async () => {
    const fx = setup()
    fx.loaded.set("local/ses_1", [])
    fx.service.set("local/ses_2", [])
    fx.answer.list = [local("ses_1"), local("ses_1")]
    await fx.panes.refresh()
    expect(fx.registered).toEqual(["local/ses_1"])
    fx.answer.list = [local("ses_1"), local("ses_2")]
    await fx.panes.refresh()
    await fx.panes.want(local("ses_2"))
    expect(fx.calls.wanted).toBe(2)
    expect(fx.registered).toEqual(["local/ses_1", "local/ses_2"])
    expect(fx.attachments.list().map((item) => item.sessionID)).toEqual(["ses_1", "ses_2"])
  })

  test("a failing RPC attaches nothing and does not throw; the next read works", async () => {
    const fx = setup()
    fx.loaded.set("local/ses_1", [])
    fx.answer.list = [local("ses_1")]
    fx.answer.fail = true
    await fx.panes.refresh()
    expect(fx.registered).toEqual([])
    fx.answer.fail = false
    await fx.panes.refresh()
    expect(fx.registered).toEqual(["local/ses_1"])
  })

  test("before the local endpoint is known nothing is attached", async () => {
    const fx = setup({ endpoint: false })
    fx.loaded.set("local/ses_1", [])
    await fx.panes.want(local("ses_1"))
    expect(fx.attachments.list()).toEqual([])
  })

  test("an SSH host's session (05 §8.10.8): read from that host, attached under it, apart from a local one", async () => {
    const fx = setup()
    fx.service.set(`${HOST}/ses_1`, [])
    fx.loaded.set("local/ses_1", [])
    fx.answer.list = [{ serverKey: HOST, sessionID: "ses_1" }, local("ses_1")]
    await fx.panes.refresh()
    expect(fx.reads).toEqual([`${HOST}/ses_1`])
    expect(fx.registered.sort()).toEqual([`${HOST}/ses_1`, "local/ses_1"])
    expect(fx.attachments.get(HOST, "ses_1")).not.toBe(fx.attachments.get(LOCAL, "ses_1"))
  })

  test("an SSH host that is not connected here gets nothing yet; the hub's next ask attaches it", async () => {
    const fx = setup({ hostConnected: false })
    fx.service.set(`${HOST}/ses_1`, [])
    await fx.panes.want({ serverKey: HOST, sessionID: "ses_1" })
    expect(fx.attachments.list()).toEqual([])
  })
})
