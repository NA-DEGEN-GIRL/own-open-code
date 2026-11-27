// 03 §5.1 (2.2.6-own.16): the new-conversation screen's server choice. Choosing a server opens its folderless screen and
// is remembered for `새 대화` and Alt+N (`newChatHost`); a host that is only disconnected connects at once, one that
// needs a sign-in, a host key check or an update is left to the screen's overlay; a forgotten host falls back to this PC.
import { afterEach, expect, test } from "bun:test"
import { LOCAL } from "@/data"
import type { Route } from "@/routing/routes"
import { newChatHost, registerRemoteStore } from "./active"
import { openNewChat } from "./new-chat"
import type { RemoteStore } from "./store"

function fakeStore(hosts: Record<string, { stage: string; paused: boolean; error: string | null }>) {
  const connected: string[] = []
  const store = {
    state: { order: Object.keys(hosts), hosts },
    connect: async (hostId: string) => {
      connected.push(hostId)
      return { stage: "connecting" }
    },
  }
  // SAFETY: openNewChat and newChatHost read the hosts and call connect; nothing else of the store is touched.
  const release = registerRemoteStore(store as unknown as RemoteStore)
  return { store, connected, release }
}

const releases: (() => void)[] = []
afterEach(() => {
  for (const release of releases.splice(0)) release()
  localStorage.clear()
})

test("a host is remembered and opened by name; a disconnected one connects at once", () => {
  const fake = fakeStore({
    "h-ubuntu1": { stage: "disconnected", paused: true, error: null },
    "h-signin1": { stage: "authentication", paused: true, error: null },
  })
  releases.push(fake.release)
  const routes: Route[] = []
  expect(newChatHost()).toBeUndefined()
  openNewChat({ serverKey: "h-ubuntu1", navigate: (route) => routes.push(route), phone: false })
  expect(routes).toEqual([{ name: "home", serverKey: "h-ubuntu1" }])
  expect(newChatHost()).toBe("h-ubuntu1")
  expect(fake.connected).toEqual(["h-ubuntu1"])
  // A sign-in is the overlay's step (its button), never started here.
  openNewChat({ serverKey: "h-signin1", navigate: (route) => routes.push(route), phone: false })
  expect(fake.connected).toEqual(["h-ubuntu1"])
  expect(newChatHost()).toBe("h-signin1")
})

test("this PC clears the choice: `/` on a wide screen, `/srv/local/new` on the phone's list tier", () => {
  const fake = fakeStore({ "h-ubuntu1": { stage: "ready", paused: false, error: null } })
  releases.push(fake.release)
  const routes: Route[] = []
  openNewChat({ serverKey: "h-ubuntu1", navigate: (route) => routes.push(route), phone: false })
  expect(fake.connected).toEqual([])
  openNewChat({ serverKey: LOCAL, navigate: (route) => routes.push(route), phone: false })
  expect(newChatHost()).toBeUndefined()
  openNewChat({ serverKey: LOCAL, navigate: (route) => routes.push(route), phone: true })
  expect(routes).toEqual([
    { name: "home", serverKey: "h-ubuntu1" },
    { name: "home" },
    { name: "home", serverKey: LOCAL },
  ])
})

test("a remembered host that is no longer listed opens this PC", () => {
  const fake = fakeStore({ "h-ubuntu1": { stage: "ready", paused: false, error: null } })
  openNewChat({ serverKey: "h-ubuntu1", navigate: () => undefined, phone: false })
  expect(newChatHost()).toBe("h-ubuntu1")
  fake.release()
  const other = fakeStore({ "h-other01": { stage: "ready", paused: false, error: null } })
  releases.push(other.release)
  expect(newChatHost()).toBeUndefined()
})
