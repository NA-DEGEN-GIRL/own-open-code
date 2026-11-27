// 03 §8 "MCP 인증 필요": a neutral banner on a session that called a tool of an MCP server which now needs a sign-in.
// The transcript knows which servers the session's tool calls named (direct MCP tools are `<server>_<tool>`, Code Mode
// calls name `<server>.<tool>`); it passes those names here. The list is createData's per-Location resource (loaded
// only when there is a name to check), and `로그인…` opens the Ctrl+; dialog where the sign-in runs (oauth.ts).
import { createEffect, createMemo, For, Show } from "solid-js"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { openMcpList } from "./layer"

export function McpAuthBanner(props: {
  /** The session's Location. */
  readonly directory: string | undefined
  /** MCP server names the session's tool calls used. */
  readonly servers: readonly string[]
}) {
  const data = useData()
  const i18n = useI18n()
  const runtime = () => data.local()
  createEffect(() => {
    const directory = props.directory
    if (directory && props.servers.length)
      void runtime()
        .data.location.mcp.server.sync({ directory })
        .catch(() => undefined)
  })
  const names = createMemo(() => {
    const directory = props.directory
    if (!directory || !props.servers.length) return []
    return (runtime().data.location.mcp.server.list({ directory }) ?? [])
      .filter((server) => server.status.status === "needs_auth" && props.servers.includes(server.name))
      .map((server) => server.name)
  })
  return (
    <For each={names()}>
      {(name) => (
        <div
          class="flex flex-wrap items-center gap-2 rounded-lg border border-own-border bg-own-subtle px-3 py-2 text-[12.5px]"
          role="status"
          data-testid="mcp-auth-banner"
          data-name={name}
        >
          <span class="min-w-0 flex-1">{i18n.t("own.mcp.needsAuth", { name })}</span>
          <Show when={props.directory}>
            {(directory) => (
              <button
                type="button"
                class="rounded-md border border-own-border px-2 py-0.5 hover:bg-own-hover"
                onClick={() => openMcpList(directory())}
              >
                {i18n.t("own.mcp.login")}
              </button>
            )}
          </Show>
        </div>
      )}
    </For>
  )
}
