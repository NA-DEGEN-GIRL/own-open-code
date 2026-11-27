// 설정 > SSH 원격 호스트 > <host>: the host's MCP line (04 §13 "MCP", MH 2026-11-26): how many of this PC's servers it
// has, how many it could still get (this PC's servers not installed there, those only this PC runs left out), and the
// way into 설정 > MCP 서버's host section on that host. Lazy chunk of the remote settings page.
import { McpHostRules } from "@own/protocol/mcp-host-rules"
import { createResource, Show } from "solid-js"
import { useData } from "@/data"
import { useRouter } from "@/routing/router"
import { remoteStore } from "@/servers"
import { setMcpHostTarget } from "./hosts-line"
import { ownSource, type HostView } from "./hosts-model"
import { useMcpHostsText } from "./hosts-strings"

export default function McpHostSummary(props: { readonly hostId: string }) {
  const data = useData()
  const text = useMcpHostsText()
  const router = useRouter()
  const local = () => data.local().rpc.allowed("mcp.list")
  const [counts] = createResource(
    () => {
      const runtime = remoteStore()?.runtime(props.hostId)
      return runtime?.connection.status() === "connected" ? { runtime, id: props.hostId } : undefined
    },
    async (source) => {
      const view = (await source.runtime.rpc.call("mcp.host.view", {}).catch(() => undefined)) as HostView | undefined
      if (!view) return undefined
      const keys = new Set(view.servers.flatMap((server) => (server.pc ? [server.pc.key] : [])))
      const mine = local() ? ((await data.local().rpc.call("mcp.list", {}).catch(() => undefined))?.servers ?? []) : []
      const missing = mine
        .map(ownSource)
        .filter((item) => !keys.has(item.key) && McpHostRules.analyze(item, { home: "" }).result !== "pc-only").length
      return { installed: view.servers.length, missing }
    },
  )
  return (
    <Show when={counts()}>
      {(value) => (
        <div class="flex flex-wrap items-center gap-2 text-[12.5px]" data-testid="remote-host-mcp">
          <span class="text-own-muted">
            {text("own.mcph.hostPage", { installed: value().installed, missing: value().missing })}
          </span>
          <Show when={local()}>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              data-testid="remote-host-mcp-open"
              onClick={() => {
                setMcpHostTarget(props.hostId)
                router.navigate({ name: "settings", section: "mcp" })
              }}
            >
              {text("own.mcph.hostPageOpen")}
            </button>
          </Show>
        </div>
      )}
    </Show>
  )
}
