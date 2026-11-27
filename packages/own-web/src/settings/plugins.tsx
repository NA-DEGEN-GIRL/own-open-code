// Settings > 플러그인 (03 §5.7 "플러그인" row, §5.7.1): (a) the built-in own plugins, always on; (b) the third-party
// Claude subscription plugin, which ships with the app and is always on (02 §8.2, 2026-10-18): version, the bundle's
// integrity and order, the risk notice as information, a link to its accounts; (c) computer use (version and state from `own.computer status`, managed
// in 설정 > 실험, 01 §10.2); (d) project plugin approvals from
// `plugin.trust.list` (control location), refreshed by `plugin.trust.changed`. Approval is two-step (plan → confirm
// with the full hashes → execute); revoking is one step because it only tightens protection.
import type { Plugin } from "@own/protocol"
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useData } from "@/data"
import type { OwnOutput } from "@/data/rpc"
import { useI18n } from "@/i18n"
import { RiskNotice, createClaudeStatus } from "@/accounts/claude-slot"
import { computerStore } from "@/computer"
import { usePanelText } from "@/computer/panel-strings"
import { errorData, errorMessage, errorType } from "@/accounts/errors"
import { copyText, Dialog, Notice, Spinner, Tag, createStatus, StatusLine } from "@/limits/kit"
import { RouteLink } from "@/routing/router"
import { useSettingsPluginsText } from "./plugins-strings"

export default function PluginSettings() {
  const data = useData()
  const i18n = useI18n()
  const st = useSettingsPluginsText()
  const own = data.local().own
  const claude = createClaudeStatus(own)
  const health = () => own.state.health
  const status = () => claude.status()
  return (
    <div class="flex flex-col" data-testid="settings-plugins">
      <p class="m-0 text-[13px] leading-5 text-own-muted">{st("own.set.plugins.lead")}</p>
      <section class="own-psec !mt-2">
        <div class="own-psec-head">
          <h2>{st("own.set.pluginsBuiltin")}</h2>
        </div>
        <ul class="m-0 flex list-none flex-col gap-2 p-0 text-[13px]">
          <For
            each={[
              {
                key: "accounts",
                label: st("own.set.pluginAccounts"),
                name: "@own/accounts",
                version: health()?.pluginVersions?.accounts,
              },
              {
                key: "telemetry",
                label: st("own.set.pluginTelemetry"),
                name: "@own/telemetry",
                version: health()?.pluginVersions?.telemetry ?? undefined,
              },
            ]}
          >
            {(plugin) => (
              <li class="flex flex-wrap items-center gap-2" data-plugin={plugin.key}>
                <span class="font-semibold">{plugin.label}</span>
                <span class="own-mono text-own-faint">{plugin.name}</span>
                <Tag tone="soft">{st("own.set.alwaysOn")}</Tag>
                <span class="ml-auto text-own-muted">
                  {plugin.version ? `v${plugin.version}` : i18n.t("own.conf.unknown")} ·{" "}
                  {own.state.status === "ready" ? st("own.set.pluginActive") : st("own.set.pluginInactive")}
                </span>
              </li>
            )}
          </For>
        </ul>
      </section>

      <section class="own-psec" data-testid="plugins-claude">
        {/* The two tags go under the title when the page is narrow (a phone). */}
        <div class="own-psec-head flex-wrap">
          <h2>{st("own.set.pluginsThirdParty")}</h2>
          <span class="ml-auto flex flex-wrap items-center justify-end gap-2">
            <Tag tone="soft">{i18n.t("own.claude.builtIn.tag")}</Tag>
            <Tag tone="danger">{i18n.t("own.claude.badge")}</Tag>
          </span>
        </div>
        <Show when={status()} fallback={<p class="own-placeholder px-0">{i18n.t("own.shell.loading")}</p>}>
          {(current) => (
            <div class="flex flex-col gap-2 text-[13px]">
              <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
                <dt class="text-own-muted">{st("own.acct.claudePackage")}</dt>
                <dd class="own-mono m-0">opencode-claude-auth-v2</dd>
                <dt class="text-own-muted">{st("own.set.pluginState")}</dt>
                <dd class="m-0" data-testid="claude-plugin-state">
                  {current().order !== "missing"
                    ? st("own.set.claudeLoaded", { version: current().version ?? "—" })
                    : current().installed
                      ? st("own.set.claudeNotLoaded", { version: current().version ?? "—" })
                      : st("own.set.claudeMissing")}
                </dd>
                <dt class="text-own-muted">{st("own.acct.claudeIntegrity")}</dt>
                <dd class="m-0" data-testid="claude-plugin-integrity">
                  {current().integrityOk === null
                    ? "—"
                    : current().integrityOk
                      ? st("own.set.integrityOk")
                      : i18n.t("own.acct.claudeWarn.integrity")}
                </dd>
                <dt class="text-own-muted">{st("own.set.pluginOrder")}</dt>
                <dd class="m-0">
                  {current().order === "ok"
                    ? st("own.set.orderOk")
                    : i18n.t("own.acct.claudeWarn.order", { order: current().order })}
                </dd>
              </dl>
              <p class="m-0 text-[12px] text-own-muted">{st("own.set.pluginPinned")}</p>
              <details class="text-[12.5px]">
                <summary class="cursor-pointer text-own-muted">{i18n.t("own.claude.builtIn.risk")}</summary>
                <div class="mt-2">
                  <RiskNotice />
                </div>
              </details>
              <RouteLink
                to={{ name: "accounts" }}
                class="own-target inline-block text-[12.5px] text-own-accent-text no-underline hover:underline"
              >
                {st("own.set.claudeAccounts")} →
              </RouteLink>
            </div>
          )}
        </Show>
      </section>

      <ComputerPlugin />

      <ProjectTrust />
    </div>
  )
}

/** (c) Computer use: launcher-managed like the built-ins, but off in every session until the session turns it on. */
function ComputerPlugin() {
  const i18n = useI18n()
  const st = useSettingsPluginsText()
  const text = usePanelText()
  createEffect(on(computerStore, (store) => store?.ensure()))
  const state = () => {
    const store = computerStore()
    if (!store || store.state.load === "idle" || store.state.load === "loading") return undefined
    if (store.state.load === "missing") return text("own.computer.unavailable")
    const status = store.state.status
    if (status?.available) return `v${status.version} · ${st("own.set.pluginActive")}`
    return status?.reason ? text(`own.computer.reason.${status.reason}`) : text("own.computer.unavailable")
  }
  return (
    <section class="own-psec" data-testid="plugins-computer">
      <div class="own-psec-head">
        <h2>{i18n.t("own.set.computerUse")}</h2>
      </div>
      <div class="flex flex-wrap items-center gap-2 text-[13px]">
        <span class="own-mono text-own-faint">@own/computer-use</span>
        <span class="ml-auto text-own-muted" data-testid="plugins-computer-state">
          {state() ?? i18n.t("own.conf.unknown")}
        </span>
      </div>
      <p class="m-0 mt-1 text-[12px] text-own-muted">{st("own.set.computerUseNote")}</p>
      <RouteLink
        to={{ name: "settings", section: "experimental" }}
        class="own-target mt-1 inline-block text-[12.5px] text-own-accent-text no-underline hover:underline"
      >
        {text("own.computer.manage")} →
      </RouteLink>
    </section>
  )
}

type TrustLocation = Plugin.TrustLocation
type TrustPlan = OwnOutput<"plugin.trust.approve.plan">

/** 5.7.1 project plugin approvals. */
function ProjectTrust() {
  const data = useData()
  const i18n = useI18n()
  const st = useSettingsPluginsText()
  const own = data.local().own
  const [locations, setLocations] = createSignal<readonly TrustLocation[]>()
  const [picked, setPicked] = createStore<Record<string, boolean>>({})
  const [changed, setChanged] = createStore<Record<string, boolean>>({})
  const [plan, setPlan] = createSignal<TrustPlan>()
  const [copied, setCopied] = createSignal(false)
  const status = createStatus()
  const key = (directory: string, sourceID: string) => `${directory}\u0000${sourceID}`
  const load = () =>
    own.rpc
      .call("plugin.trust.list", {})
      .then((output) => void setLocations(output.locations))
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
  void load()
  onCleanup(own.on("plugin.trust.changed", () => void load()))
  const projectName = (directory: string) =>
    Object.values(data.local().sessions.state.projects).find((project) => project.directory === directory)?.name ??
    directory.split(/[\\/]/).filter(Boolean).at(-1) ??
    directory

  const approve = async (directory: string, sources: readonly string[]) => {
    status.clear()
    await own.rpc
      .call("plugin.trust.approve.plan", { directory, sources: [...sources] })
      .then((next) => void setPlan(next))
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
  }
  const revoke = async (directory: string, sourceID: string) => {
    status.clear()
    await own.rpc
      .call("plugin.trust.revoke", { directory, source: sourceID })
      .then(() => load())
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
  }
  const allowed = () => own.rpc.allowed("plugin.trust.approve.plan")

  return (
    <section class="own-psec" data-testid="project-trust">
      <div class="own-psec-head">
        <h2>{st("own.plugins.project")}</h2>
      </div>
      <Notice tone="info">
        {i18n.t("own.plugins.projectLimit")}{" "}
        <button
          type="button"
          class="own-btn ml-1"
          data-size="sm"
          onClick={() => void copyText("own open --untrusted").then(setCopied)}
        >
          {i18n.t(copied() ? "own.acct.copied" : "own.state.copyCommand")}
        </button>
      </Notice>
      <StatusLine status={status} testid="trust-status" />
      <Show when={locations()} fallback={<p class="own-placeholder px-0">{i18n.t("own.shell.loading")}</p>}>
        {(list) => (
          <For each={list()} fallback={<p class="own-placeholder px-0">{st("own.set.noProjects")}</p>}>
            {(location) => {
              const pending = () => location.plugins.filter((plugin) => !plugin.approved)
              const chosen = () => pending().filter((plugin) => picked[key(location.directory, plugin.source)])
              return (
                <div
                  class="mt-3 rounded-[10px] border border-own-border p-3"
                  data-directory={location.directory}
                  data-testid="trust-location"
                >
                  <div class="flex flex-wrap items-center gap-2 text-[13px]">
                    <b class="font-semibold" title={location.directory}>
                      {projectName(location.directory)}
                    </b>
                    <span class="own-mono min-w-0 truncate text-[11.5px] text-own-faint" title={location.directory}>
                      {location.directory}
                    </span>
                    <span class="ml-auto" data-testid="trust-location-status">
                      <Show
                        when={location.status === "blocked_by_plugin"}
                        fallback={<Tag tone="ok">{i18n.t("own.set.trustOk")}</Tag>}
                      >
                        <Tag tone="danger">{st("own.plugins.projectBlocked", { n: pending().length })}</Tag>
                      </Show>
                    </span>
                  </div>
                  <Show
                    when={location.plugins.length}
                    fallback={<p class="m-0 mt-2 text-[12.5px] text-own-faint">{st("own.set.noProjectPlugins")}</p>}
                  >
                    <table class="own-tbl mt-2">
                      <thead>
                        <tr>
                          <th scope="col">
                            <span class="sr-only">{st("own.plugins.approve")}</span>
                          </th>
                          <th scope="col">{st("own.set.pluginID")}</th>
                          <th scope="col">{st("own.set.pluginSource")}</th>
                          <th scope="col">sha256</th>
                          <th scope="col">{st("own.set.pluginState")}</th>
                          <th scope="col" />
                        </tr>
                      </thead>
                      <tbody>
                        <For each={location.plugins}>
                          {(plugin) => (
                            <tr data-testid="trust-row" data-source={plugin.source}>
                              <td>
                                <Show when={!plugin.approved && allowed()}>
                                  <input
                                    type="checkbox"
                                    aria-label={st("own.plugins.approve")}
                                    checked={!!picked[key(location.directory, plugin.source)]}
                                    onChange={(event) =>
                                      setPicked(key(location.directory, plugin.source), event.currentTarget.checked)
                                    }
                                  />
                                </Show>
                              </td>
                              <td class="own-mono">{plugin.id}</td>
                              <td class="own-mono max-w-[260px] truncate text-[12px]" title={plugin.source}>
                                {plugin.source}
                              </td>
                              <td class="own-mono text-[12px]" title={plugin.sha256}>
                                {plugin.sha256.slice(0, 12)}
                              </td>
                              <td>
                                <Show
                                  when={plugin.approved}
                                  fallback={
                                    <span class="text-own-danger">
                                      {changed[key(location.directory, plugin.source)]
                                        ? st("own.plugins.changed")
                                        : st("own.set.unapproved")}
                                    </span>
                                  }
                                >
                                  <span class="text-own-ok">{st("own.set.approved")}</span>
                                </Show>
                              </td>
                              <td class="own-r">
                                <Show when={allowed()}>
                                  <Show
                                    when={plugin.approved}
                                    fallback={
                                      <button
                                        type="button"
                                        class="own-btn"
                                        data-size="sm"
                                        onClick={() => void approve(location.directory, [plugin.source])}
                                        data-testid="trust-approve"
                                      >
                                        {st("own.plugins.approve")}
                                      </button>
                                    }
                                  >
                                    <button
                                      type="button"
                                      class="own-btn"
                                      data-size="sm"
                                      onClick={() => void revoke(location.directory, plugin.source)}
                                      data-testid="trust-revoke"
                                    >
                                      {st("own.plugins.revoke")}
                                    </button>
                                  </Show>
                                </Show>
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                    <Show when={chosen().length > 1}>
                      <div class="mt-2">
                        <button
                          type="button"
                          class="own-btn"
                          data-size="sm"
                          onClick={() =>
                            void approve(
                              location.directory,
                              chosen().map((plugin) => plugin.source),
                            )
                          }
                        >
                          {st("own.set.approveSelected", { n: chosen().length })}
                        </button>
                      </div>
                    </Show>
                  </Show>
                </div>
              )
            }}
          </For>
        )}
      </Show>
      <ApproveDialog
        plan={plan()}
        onClose={(result) => {
          setPlan(undefined)
          if (result?.mismatch) setChanged(key(result.mismatch.directory, result.mismatch.source), true)
          void load()
        }}
        onReplan={(directory, sources) => void approve(directory, sources)}
      />
    </section>
  )
}

/** 5.7.1 step 2–3: every plugin with its id, source and the full hash the server just computed; then execute. */
function ApproveDialog(props: {
  readonly plan: TrustPlan | undefined
  readonly onClose: (result?: { mismatch?: { directory: string; source: string } }) => void
  readonly onReplan: (directory: string, sources: readonly string[]) => void
}) {
  const data = useData()
  const i18n = useI18n()
  const st = useSettingsPluginsText()
  const own = data.local().own
  const [busy, setBusy] = createSignal(false)
  const status = createStatus()
  const run = async (plan: TrustPlan) => {
    setBusy(true)
    status.clear()
    await own.rpc
      .call("plugin.trust.approve.execute", { nonce: plan.nonce })
      .then(() => props.onClose())
      .catch((error: unknown) => {
        const type = errorType(error)
        // 5.7.1: an expired nonce plans again with fresh hashes and keeps the dialog open.
        if (type === "nonce_invalid")
          return props.onReplan(
            plan.directory,
            plan.plugins.map((plugin) => plugin.source),
          )
        if (type === "trust_hash_mismatch") {
          const mismatch = errorData<{ source: string }>(error)
          status.error(st("own.plugins.hashMismatch"))
          return props.onClose({ mismatch: { directory: plan.directory, source: mismatch.source ?? "" } })
        }
        status.error(errorMessage(i18n, error))
      })
    setBusy(false)
  }
  return (
    <Show when={props.plan}>
      {(plan) => (
        <Dialog
          open
          title={st("own.set.approveTitle", { n: plan().plugins.length })}
          onClose={() => props.onClose()}
          size="wide"
          testid="trust-approve-dialog"
          footer={
            <>
              <button type="button" class="own-btn" onClick={() => props.onClose()}>
                {i18n.t("own.kit.cancel")}
              </button>
              <button
                type="button"
                class="own-btn"
                data-variant="danger"
                disabled={busy()}
                onClick={() => void run(plan())}
                data-testid="trust-approve-run"
              >
                <Show when={busy()}>
                  <Spinner />
                </Show>
                {st("own.plugins.approve")}
              </button>
            </>
          }
        >
          <p class="own-mono m-0 mb-2 break-all text-[12px] text-own-muted">{plan().directory}</p>
          <ul class="m-0 flex list-none flex-col gap-2 p-0">
            <For each={plan().plugins}>
              {(plugin) => (
                <li class="rounded-lg border border-own-border p-2.5 text-[12.5px]">
                  <p class="own-mono m-0 font-semibold">{plugin.id}</p>
                  <p class="own-mono m-0 break-all text-own-muted">{plugin.source}</p>
                  <p class="own-mono m-0 mt-1 select-all break-all text-[11.5px]" data-testid="trust-sha">
                    {plugin.sha256}
                  </p>
                </li>
              )}
            </For>
          </ul>
          <div class="mt-3">
            <Notice tone="warn">{plan().warning.trim() || st("own.plugins.approveWarn")}</Notice>
          </div>
          <StatusLine status={status} />
        </Dialog>
      )}
    </Show>
  )
}
