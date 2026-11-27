// A host conversation's line (04 §13 "MCP", MH 2026-11-26): `이 PC의 MCP 서버 N개가 <host>에 없어요. [설치…] [닫기]`,
// when this PC has servers the host could install right away (`설치 가능`). Not nagging: closing it keeps it closed for
// that host until the set of such servers changes (per browser). Lazy chunk of the session banners; this PC's windows
// only (installing is `local`).
import { McpHostRules } from "@own/protocol/mcp-host-rules"
import { createResource, createSignal, Show } from "solid-js"
import { useData } from "@/data"
import { useRouter } from "@/routing/router"
import { remoteStore } from "@/servers"
import { setMcpHostTarget } from "./hosts-line"
import { missingKey, ownSource, rows, type HostView, type Probe } from "./hosts-model"
import { useMcpHostsText } from "./hosts-strings"

const DISMISSED = "own.web.mcpHostHint."

export default function McpHostHint(props: { readonly hostId: string }) {
  const data = useData()
  const text = useMcpHostsText()
  const router = useRouter()
  const [closed, setClosed] = createSignal<string | null>(read(props.hostId))
  const [found] = createResource(
    () => {
      const runtime = remoteStore()?.runtime(props.hostId)
      return runtime?.connection.status() === "connected" ? { runtime } : undefined
    },
    async (source) => {
      const view = (await source.runtime.rpc.call("mcp.host.view", {}).catch(() => undefined)) as HostView | undefined
      if (!view) return undefined
      const mine = (await data.local().rpc.call("mcp.list", {}).catch(() => undefined))?.servers ?? []
      if (mine.length === 0) return undefined
      const probe = (await source.runtime.rpc.call("mcp.host.probe", {}).catch(() => undefined)) as Probe | undefined
      const home = (await data.local().rpc.call("folderPicker.get", {}).catch(() => undefined))?.home ?? ""
      const list = rows(mine.map(ownSource), { status: "ready", view, ...(probe ? { probe } : {}) }, [], {
        home,
        hostId: props.hostId,
      }, McpHostRules)
      const key = missingKey(list)
      return key ? { key, count: key.split("|").length } : undefined
    },
  )
  const name = () => remoteStore()?.host(props.hostId)?.name ?? props.hostId
  return (
    <Show when={found() && found()!.key !== closed() ? found() : undefined}>
      {(value) => (
        <div
          class="flex flex-wrap items-center gap-2 rounded-lg border border-own-border px-3 py-1.5 text-[12.5px] text-own-muted"
          data-testid="mcp-host-hint"
        >
          <span class="min-w-0 flex-1">{text("own.mcph.chat.line", { n: value().count, host: name() })}</span>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-testid="mcp-host-hint-install"
            onClick={() => {
              setMcpHostTarget(props.hostId)
              router.navigate({ name: "settings", section: "mcp" })
            }}
          >
            {text("own.mcph.chat.install")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-testid="mcp-host-hint-dismiss"
            onClick={() => {
              write(props.hostId, value().key)
              setClosed(value().key)
            }}
          >
            {text("own.mcph.chat.dismiss")}
          </button>
        </div>
      )}
    </Show>
  )
}

function read(hostId: string) {
  try {
    return localStorage.getItem(DISMISSED + hostId)
  } catch {
    return null
  }
}

function write(hostId: string, key: string) {
  try {
    localStorage.setItem(DISMISSED + hostId, key)
  } catch {}
}
