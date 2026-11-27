// 03 §4.3: the server sections of this browser — default order, the user's, what is new or away, folding.
import { afterEach, expect, test } from "bun:test"
import { registerRemotePcStore } from "@/remote-pcs/active"
import type { RemotePcStore } from "@/remote-pcs/store"
import { registerRemoteStore } from "./active"
import { arrangedServers, arrangeServers, hasRemoteHosts, serverCollapsed, serverOrder, toggleServer } from "./order"
import type { RemoteStore } from "./store"

const stops: (() => void)[] = []

afterEach(() => {
  stops.splice(0).forEach((stop) => stop())
  arrangeServers([])
  localStorage.clear()
})

function servers(hosts: readonly string[], pcs: readonly string[] = []) {
  // SAFETY: the order reads only the host ids and the PCs' keys.
  stops.push(registerRemoteStore({ state: { order: hosts } } as unknown as RemoteStore))
  stops.push(registerRemotePcStore({ pcs: () => pcs.map((pcKey) => ({ pcKey })) } as unknown as RemotePcStore))
}

test("this PC, the hosts and the other PCs, until the user arranges them", () => {
  expect(serverOrder()).toEqual(["local"])
  expect(hasRemoteHosts()).toBe(false)
  servers(["h1", "h2"], ["home"])
  expect(hasRemoteHosts()).toBe(true)
  expect(serverOrder()).toEqual(["local", "h1", "h2", "pc:home"])
  arrangeServers(["h2", "pc:home", "local", "h1"])
  expect(serverOrder()).toEqual(["h2", "pc:home", "local", "h1"])
  expect(JSON.parse(localStorage.getItem("own.web.servers.order")!)).toEqual(["h2", "pc:home", "local", "h1"])
  arrangeServers([])
  expect(serverOrder()).toEqual(["local", "h1", "h2", "pc:home"])
})

test("a host added later comes last; one that is away keeps its place", () => {
  servers(["h1", "h2", "h3"])
  arrangeServers(["h2", "gone", "local", "h1"])
  expect(serverOrder()).toEqual(["h2", "local", "h1", "h3"])
  expect(arrangedServers()).toContain("gone")
})

test("folding is kept, and a lone section is never folded", () => {
  servers(["h1"])
  toggleServer("local")
  expect(serverCollapsed("local")).toBe(true)
  expect(JSON.parse(localStorage.getItem("own.web.remote.collapsed")!)).toEqual(["local"])
  // The last host is removed: this PC has no header to unfold it with.
  stops.splice(0).forEach((stop) => stop())
  expect(serverCollapsed("local")).toBe(false)
  servers(["h1"])
  expect(serverCollapsed("local")).toBe(true)
  toggleServer("local")
  expect(serverCollapsed("local")).toBe(false)
})
