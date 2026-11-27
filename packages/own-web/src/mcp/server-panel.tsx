// Server status popover content (03 §4.3): service version, trust mode, guard, the MCP summary of the project on screen
// (`MCP 3 · 로그인 필요 1`, 18.14; §8 "MCP 인증 필요" badge), this window's browser tool rule (01 §10.1) and, on
// desktop, the way to restart the service (16.3; the restart itself lives in 설정 > 서버 연결 with its mode rule) and
// the app's 앱 종료 / 완전 종료… (05 §7.3).
// Lazy chunk, created only while the popover is open.
import { createEffect, createResource, on, Show } from "solid-js"
import { QuitButtons } from "@/app-quit"
import { useData } from "@/data"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { useSessionBrowserTool } from "@/policy/notice"
import { browserPolicyLine, usePanelText } from "@/policy/panel"
import { usePolicyText } from "@/policy/strings"
import { activeDirectory } from "@/projects/active"
import { baseName } from "@/projects/path"
import { useRouter } from "@/routing/router"
import { openMcpList } from "./layer"
import { summarize } from "./model"
import { createMcpServers } from "./store"
import { useMcpListText } from "./list-strings"

const GUARD = { ok: "own.set.guardOk", skew: "own.set.guardSkew", unmanaged: "own.set.guardUnmanaged" } as const

export default function ServerPanel(props: { readonly onNavigate: () => void; readonly onLayout?: () => void }) {
  const data = useData()
  const host = useHost()
  const i18n = useI18n()
  const text = useMcpListText()
  const policy = usePolicyText()
  const panel = usePanelText()
  const router = useRouter()
  const runtime = data.local()
  const health = () => runtime.own.state.health
  const [service] = createResource(() => host.service?.status().catch(() => undefined))
  const directory = () => activeDirectory(runtime, router.route())
  const mcp = createMcpServers({ runtime: () => runtime, directory, host })
  const summary = () => summarize(mcp.rows())
  const sessionID = () => {
    const route = router.route()
    return route.name === "session" && route.serverKey === runtime.key ? route.sessionID : undefined
  }
  const browser = useSessionBrowserTool(sessionID)
  // The popover sits above its button: keep it anchored when the content grows.
  createEffect(on([() => mcp.rows().length, mcp.loaded, service], () => props.onLayout?.()))

  const go = (section: "server" | "mcp") => {
    props.onNavigate()
    router.navigate({ name: "settings", section })
  }

  return (
    <div class="flex flex-col gap-2 text-[12.5px]" data-testid="server-panel-body">
      <p class="m-0 text-[13px] font-semibold">
        {i18n.t("own.nav.thisPc")} ·{" "}
        {i18n.t(runtime.connection.status() === "connected" ? "own.nav.server.connected" : "own.nav.server.connecting")}
      </p>
      <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt class="text-own-muted">{i18n.t("own.set.version")}</dt>
        <dd class="m-0 font-mono">{health()?.version ?? "—"}</dd>
        <dt class="text-own-muted">{i18n.t("own.set.trustMode")}</dt>
        <dd class="m-0">
          {service()?.mode
            ? i18n.t(service()!.mode === "untrusted" ? "own.set.untrusted" : "own.set.trusted")
            : i18n.t("own.conf.unknown")}
        </dd>
        <dt class="text-own-muted">{i18n.t("own.set.guard")}</dt>
        <dd class="m-0" data-testid="server-panel-guard">
          {health() ? i18n.t(GUARD[health()!.guard]) : i18n.t("own.conf.unknown")}
        </dd>
        <dt class="text-own-muted">{text("own.server.browser")}</dt>
        <dd class="m-0" data-testid="server-panel-browser" title={policy("own.policy.browser.why")}>
          {panel(browserPolicyLine(browser(), host))}
        </dd>
      </dl>
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded-md border border-own-border px-2 py-1.5 text-left hover:bg-own-hover disabled:opacity-60"
        disabled={!directory()}
        data-testid="server-panel-mcp"
        title={directory()}
        onClick={() => {
          props.onNavigate()
          openMcpList(directory())
        }}
      >
        <span class="min-w-0 flex-1 truncate">
          <Show when={directory()} fallback={text("own.mcp.summaryNoProject")}>
            <Show when={mcp.loaded()} fallback={text("own.mcp.loading")}>
              <Show when={summary().total} fallback={text("own.mcp.summaryNone")}>
                {text("own.mcp.summary", { n: summary().total })}
                <Show when={summary().needsAuth}>
                  {" · "}
                  <span class="text-own-warn" data-testid="server-panel-mcp-auth">
                    {text("own.mcp.summaryAuth", { n: summary().needsAuth })}
                  </span>
                </Show>
                <Show when={summary().failed}>
                  {" · "}
                  <span class="text-own-danger">{text("own.mcp.summaryFailed", { n: summary().failed })}</span>
                </Show>
              </Show>
            </Show>
          </Show>
        </span>
        <Show when={directory()}>
          <span class="max-w-[12ch] truncate text-[11px] text-own-faint">{baseName(directory()!)}</span>
        </Show>
      </button>
      <div class="flex flex-wrap gap-1.5 pt-1">
        <button type="button" class="rounded-md px-2 py-1 hover:bg-own-hover" onClick={() => go("server")}>
          {text("own.server.settings")}
        </button>
        <Show when={host.capabilities.serviceControl && host.service}>
          <button
            type="button"
            class="rounded-md px-2 py-1 hover:bg-own-hover"
            data-testid="server-panel-restart"
            onClick={() => go("server")}
          >
            {text("own.server.restart")}
          </button>
        </Show>
      </div>
      {/* 05 §7.3: the desktop app's 앱 종료 and 완전 종료… (the shell asks before it stops anything). */}
      <QuitButtons
        class="flex flex-wrap gap-1.5 border-t border-own-border pt-2"
        buttonClass="rounded-md px-2 py-1 hover:bg-own-hover"
      />
    </div>
  )
}
