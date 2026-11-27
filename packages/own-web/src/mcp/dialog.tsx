// MCP list dialog (03 §10 `Ctrl+;`, same as upstream; §18.14). Lazy chunk. Works on the project on screen; full
// management (another project) is in 설정 > MCP. With no server, this PC's windows get `＋ 서버 추가…` and `다른 도구에서
// 가져오기…`, which open the settings page with the form or the import dialog (SM, `settings/intent.ts`). own's servers
// show own.accounts' error text with their values cut out (`mcp.list` with the folder; elsewhere none, SM-22).
// SG (2026-10-26): the switch is this project's only (the sentence under the folder says so and where every project is
// set); each row says what decides it here, with `되돌리기` for this project's own switch.
import { createResource, onCleanup, Show } from "solid-js"
import { useData } from "@/data"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { Dialog } from "@/limits/kit"
import { useRouter } from "@/routing/router"
import { requestSettingsIntent, type SettingsIntent } from "@/settings/intent"
import { McpServerList, type McpSwitches } from "./list"
import { reaches } from "./manage-model"
import { createMcpServers, keeps } from "./store"
import { useMcpListText } from "./list-strings"
import { useMcpManageText } from "./manage-strings"

export interface McpDialogProps {
  readonly directory?: string
  /** The folder on screen is not known yet: wait instead of saying no project is open. */
  readonly pending?: boolean
  readonly onClose: () => void
}

export default function McpDialog(props: McpDialogProps) {
  const data = useData()
  const host = useHost()
  const i18n = useI18n()
  const text = useMcpListText()
  const manage = useMcpManageText()
  const router = useRouter()
  const rpc = () => data.local().rpc
  const local = () => rpc().allowed("mcp.list")
  const mcp = createMcpServers({
    runtime: () => data.local(),
    directory: () => props.directory,
    host,
    own: () => {
      const read = local() ? view : summary
      if (!rpc().allowed("mcp.summary") && !local()) return undefined
      // `error` first: a resource's `latest` throws its error.
      if (read.error) return { names: [] }
      if (read.latest === undefined) return { names: "all" }
      return {
        names: read.latest.servers.flatMap((server) => (reaches(server.scope, props.directory) ? [server.name] : [])),
        ...(local() ? { errors: view.latest?.errors } : {}),
      }
    },
  })
  const [view, { refetch }] = createResource(
    () => (local() && props.directory ? { directory: props.directory, failures: mcp.failures() } : undefined),
    (source) => rpc().call("mcp.list", { directory: source.directory }),
  )
  const [summary, { refetch: refetchSummary }] = createResource(
    () => (!local() && rpc().allowed("mcp.summary") ? true : undefined),
    () => rpc().call("mcp.summary", {}),
  )
  onCleanup(
    data.local().own.on("mcp.changed", () => {
      if (local()) void refetch()
      else void refetchSummary()
    }),
  )
  // The rows read the answer only once there is one. Before the first answer a resource's `latest` reads the resource,
  // which in a row suspends the <Suspense> around this dialog (layer.tsx) until the answer: the open <dialog> leaves the
  // page and comes back no longer modal, so Esc no longer closes it. `state` and `error` do not suspend.
  const answer = () => {
    const read = local() ? view : summary
    return !read.error && (read.state === "ready" || read.state === "refreshing") ? read.latest : undefined
  }
  const switches: McpSwitches = {
    overrides: () => answer()?.overrides,
    projectOnly: (name) => {
      const where = props.directory
      if (where === undefined) return false
      return (answer()?.servers ?? []).some(
        (server) => server.name === name && server.scope.type === "project" && reaches(server.scope, where),
      )
    },
    canReset: () => keeps(data.local()),
  }
  const settings = (intent?: SettingsIntent) => {
    if (intent) requestSettingsIntent(intent)
    props.onClose()
    router.navigate({ name: "settings", section: "mcp" })
  }
  return (
    <Dialog
      open
      title={i18n.t("own.mcp.title")}
      onClose={() => props.onClose()}
      testid="mcp-dialog"
      dismissable
      footer={
        <button type="button" class="own-btn" data-size="sm" data-testid="mcp-manage" onClick={() => settings()}>
          {text("own.mcp.manage")}
        </button>
      }
    >
      <p class="own-mono m-0 mb-1 truncate text-[12px] text-own-faint" title={props.directory}>
        {props.directory}
      </p>
      <Show when={keeps(data.local())}>
        <p class="m-0 mb-2 text-[12px] text-own-muted" data-testid="mcp-dialog-note">
          {text("own.mcp.dialogNote")}
        </p>
      </Show>
      <McpServerList
        mcp={mcp}
        pending={props.pending}
        switches={switches}
        empty={
          <div class="flex flex-col gap-2" data-testid="mcp-empty">
            <p class="m-0 text-[12.5px] text-own-muted">{text("own.mcp.empty")}</p>
            <Show when={data.local().rpc.allowed("mcp.save")}>
              <div class="flex flex-wrap gap-2" data-testid="mcp-empty-actions">
                <button
                  type="button"
                  class="own-btn"
                  data-size="sm"
                  data-variant="primary"
                  data-testid="mcp-empty-add"
                  onClick={() => settings("mcp.add")}
                >
                  {manage("own.mcpm.add")}
                </button>
                <button
                  type="button"
                  class="own-btn"
                  data-size="sm"
                  data-testid="mcp-empty-import"
                  onClick={() => settings("mcp.import")}
                >
                  {manage("own.mcpm.import")}
                </button>
              </div>
            </Show>
          </div>
        }
      />
    </Dialog>
  )
}
