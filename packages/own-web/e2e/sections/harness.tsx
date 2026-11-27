// Server sections harness for Playwright (dev server only): the real App on the web host against the real server, with
// an own.remote that answers here (a host list, catalogs, `resolve` to the suite's second server) and a stand-in for
// the desktop's other PCs.
// Query switches:
//   - `?hosts=ubuntu,nas,work`: which SSH hosts are listed. `ubuntu` is ready (the second server; `front` and `token`
//     carry its address), `nas` is disconnected with a saved list, `work` needs an update, `empty` is disconnected
//     without a list.
//   - `&pcs`: the host has other PCs (집 PC connected, 회사 PC away).
//   - `&light`: the light theme. `&en`: English.
// `__sections.stage(hostId, stage)` changes a host's stage as own.remote's event would; `__sections.opened` lists the
// other PCs whose window was asked for.
import "@/styles/index.css"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { App } from "@/app"
import { createDataLayer, type HostView, type RemoteCatalog } from "@/data"
import type { HostRemotePcs, OwnHost, RemotePc } from "@/host/types"
import { createWebHost } from "@/host/web"
import { createI18n } from "@/i18n"
import { createMemoryRouter } from "@/routing/router"
import { registerRemoteStore } from "@/servers/active"
import { createRemoteStore } from "@/servers/store"

const params = new URLSearchParams(location.search)
localStorage.setItem("opencode-color-scheme", params.has("light") ? "light" : "dark")
const web = createWebHost()

const opened: string[] = []
const [pcs] = createSignal<readonly RemotePc[]>([
  { pcKey: "home", name: "집 PC", state: "connected", addedAt: 1, expiresAt: 9e15, open: false },
  { pcKey: "office", name: "회사 PC", state: "unreachable", addedAt: 2, expiresAt: 9e15, open: false },
])
const unused = () => Promise.reject(new Error("not in this harness"))
const remotePcs: HostRemotePcs = {
  list: async () => pcs(),
  pair: unused,
  waitPairing: unused,
  cancelPairing: unused,
  open: async (key) => {
    opened.push(key)
    return true
  },
  remove: async () => true,
  onChange: () => () => {},
}
const host: OwnHost = params.has("pcs")
  ? { ...web, capabilities: { ...web.capabilities, remotePcs: true }, remotePcs }
  : web

const NAMES: Record<string, string> = { ubuntu: "build-host", nas: "nas", work: "work_linux", empty: "빈 호스트" }
const STAGES: Record<string, HostView["stage"]> = {
  ubuntu: "ready",
  nas: "disconnected",
  work: "incompatible",
  empty: "disconnected",
}
const ids = (params.get("hosts") ?? "").split(",").filter(Boolean)
const view = (id: string): HostView => ({
  // SAFETY: the harness's own host id; nothing checks its shape on the page.
  id: `h-${id}` as HostView["id"],
  alias: id,
  name: NAMES[id] ?? id,
  target: `own@${id}`,
  stage: STAGES[id] ?? "disconnected",
  paused: STAGES[id] !== "ready",
  error: null,
  detail: "",
  platform: null,
  hostIdentity: null,
  identityChanged: false,
  versions: {
    local: "1",
    remote: "1",
    installed: "1",
    skew: STAGES[id] === "incompatible",
  } as unknown as HostView["versions"],
  autoConnect: true,
  loopback: "127.0.0.1",
  localPort: 0,
  epoch: 1,
  accounts: { mode: "all" } as HostView["accounts"],
  leaseSeconds: 60,
  failClosedGraceSeconds: 60,
  tokenTtlHours: 24,
  projectConfig: "instructions",
  shellEnv: "login",
  warnings: [],
  broker: { state: "connected", leasesActive: 0, spoolBacklog: 0 } as unknown as HostView["broker"],
  sessions: { active: 0 },
  events: {} as HostView["events"],
  pendingSettings: false,
  owner: { clientId: null },
  upstreamOpencodeDetected: false,
})
const hosts = new Map(ids.map((id) => [`h-${id}`, view(id)]))
let revision = 1

const now = Date.now()
const CATALOG = {
  epoch: 1,
  fetchedAt: now - 12 * 60_000,
  projects: [{ id: "proj_photos", directory: "/srv/photos", name: "photos", updatedAt: now }],
  sessions: [
    {
      id: "ses_photos0000000000000001",
      directory: "/srv/photos",
      title: "사진 백업 스크립트",
      updatedAt: now - 3_600_000,
      model: null,
    },
    {
      id: "ses_photos0000000000000002",
      directory: "/srv/photos",
      title: "중복 찾기",
      updatedAt: now - 7_200_000,
      model: null,
    },
  ],
} as unknown as RemoteCatalog

async function answer(method: string, payload: { hostId?: string }): Promise<unknown> {
  const id = payload.hostId
  if (method === "hosts.list") return { hosts: [...hosts.values()], revision }
  if (method === "catalog.get")
    return id === "h-empty" || id === "h-work" ? { ...CATALOG, projects: [], sessions: [] } : CATALOG
  if (method === "resolve")
    return hosts.get(id!)?.stage === "ready"
      ? {
          url: params.get("front"),
          token: params.get("token"),
          tokenExpiresAt: 9e15,
          epoch: 1,
          controlDir: params.get("control"),
          home: "/home/own",
        }
      : { url: null }
  if (method === "connect") {
    const stage = hosts.get(id!)?.stage ?? "disconnected"
    setStage(id!, "ready")
    return { stage }
  }
  return {}
}

const data = createDataLayer({ host })
const remote = {
  ...data.remote,
  call: (method: string, payload: { hostId?: string }) => answer(method, payload),
  allowed: () => true,
} as unknown as typeof data.remote
const layer = Object.create(data, { remote: { value: remote } }) as typeof data

const router = createMemoryRouter(`own.web.sections.${params.get("window") ?? "main"}`)
render(
  () => <App host={host} router={router} data={data} i18n={createI18n(params.has("en") ? "en" : "ko")} />,
  document.getElementById("root")!,
)
// After the app's own layer, which registered a store of the real (absent) own.remote.
const store = createRemoteStore({ data: layer })
if (ids.length || params.has("remote")) registerRemoteStore(store)
void store.refresh()

function setStage(id: string, stage: HostView["stage"]) {
  const current = hosts.get(id)
  if (!current) return
  hosts.set(id, { ...current, stage, paused: stage !== "ready" })
  revision++
  void store.refresh()
}

Object.assign(window, { __sections: { router, opened, stage: setStage, store } })
