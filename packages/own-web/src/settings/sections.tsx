// Smaller settings pages (03 §5.7): 일반, 화면 배치, 서비스 상태, 데스크톱 앱 (capability-gated). 단축키 is src/palette,
// 셸·터미널 src/settings/shell, 컴퓨터 사용 (실험) src/computer/panel.
import { useTheme } from "@opencode/ui/theme/context"
import { createResource, createSignal, For, Show } from "solid-js"
import { useData } from "@/data"
import { QuitButtons } from "@/app-quit"
import { useQuitSettingsText } from "@/app-quit/settings-strings"
import { useHost } from "@/host"
import type { CloseAction, HostApp } from "@/host/types"
import { useI18n } from "@/i18n"
import { followUp } from "@/composer/send"
import { SEND_KEYS, sendKey, sendKeyLabels } from "@/composer/send-key"
import { sendKeyName } from "@/composer/send-key-menu"
import { useSendKeyText } from "@/composer/send-key-strings"
import { editorPreference } from "@/files/editor"
import { LimitDisplaySetting } from "@/limits/display-setting"
import { copyText, Segmented, Tag, TextField, createStatus, StatusLine } from "@/limits/kit"
import { TIER_LAYOUT } from "@/shell/breakpoints"
import { useShell } from "@/shell/context"
import { COLOR_SCHEMES } from "@/shell/theme-default"
import { ZoomControl } from "@/shell/zoom"
import { zoomState } from "@/shell/zoom-state"
import { setSidebarDensity, sidebarDensity } from "@/sidebar/local-state"
import { TimelineDetailSetting } from "@/timeline-settings/setting"
import { ChatViewSetting } from "@/chat-view/setting"
import { HarnessDefaultSetting } from "@/harness/default-setting"
import { FolderSettings } from "@/projects/folder-settings"
import { useSettingsSectionsText } from "./sections-strings"

export function GeneralSettings() {
  const i18n = useI18n()
  const host = useHost()
  const st = useSettingsSectionsText()
  const theme = useTheme()
  const sendKeyText = useSendKeyText()
  const keys = () => sendKeyLabels(sendKey.value())
  return (
    <div class="flex flex-col" data-testid="settings-general">
      <Setting title={st("own.shell.themeLabel")}>
        <Segmented
          label={st("own.shell.themeLabel")}
          value={theme.colorScheme()}
          options={COLOR_SCHEMES.map((scheme) => ({
            value: scheme,
            label: i18n.t(`own.shell.theme.${scheme}`),
          }))}
          onChange={(scheme) => theme.setColorScheme(scheme)}
          testid="settings-theme"
        />
      </Setting>
      <Setting title={st("own.set.language")}>
        <Segmented
          label={st("own.set.language")}
          value={i18n.locale()}
          options={[
            { value: "ko", label: "한국어" },
            { value: "en", label: "English" },
          ]}
          onChange={(locale) => i18n.setLocale(locale)}
          testid="settings-language"
        />
      </Setting>
      {/* 4.2.1, 05 §7.9: this PC's window zoom, on hosts that zoom their windows (desktop). */}
      <ZoomSetting />
      <Setting title={st("own.set.density")}>
        <Segmented
          label={st("own.set.density")}
          value={sidebarDensity()}
          options={(["comfortable", "compact"] as const).map((density) => ({
            value: density,
            label: i18n.t(`own.set.density.${density}`),
          }))}
          onChange={(density) => setSidebarDensity(density)}
          testid="settings-density"
        />
      </Setting>
      {/* 4.6 보내는 키: the conversation composer's send key (also `▾` beside 전송 and the palette). A touch screen sends
          with the button and hides the key menu too (MUX). */}
      <Show when={!host.capabilities.touch}>
        <Setting
          title={sendKeyText("own.sendKey.title")}
          note={sendKeyText("own.sendKey.settingNote", { newline: keys().newline })}
        >
          <Segmented
            label={sendKeyText("own.sendKey.title")}
            value={sendKey.value()}
            options={SEND_KEYS.map((mode) => ({ value: mode, label: sendKeyName(mode, sendKeyText) }))}
            onChange={(mode) => sendKey.set(mode)}
            testid="settings-send-key"
          />
        </Setting>
      </Show>
      {/* 4.6: the note names both keys and where each sends now (`Ctrl+Enter는 끼워 넣기로, Alt+Enter는 대기열로 보내요.`). */}
      <Setting
        title={st("own.set.followUp")}
        note={
          host.capabilities.touch
            ? undefined
            : i18n.t("own.set.followUp.note", {
                send: keys().send,
                mine: i18n.t(`own.set.followUp.${followUp.value()}`),
                other: keys().other,
                rest: i18n.t(followUp.value() === "steer" ? "own.set.followUp.queue" : "own.set.followUp.steer"),
              })
        }
      >
        <Segmented
          label={st("own.set.followUp")}
          value={followUp.value()}
          options={(["steer", "queue"] as const).map((mode) => ({
            value: mode,
            label: i18n.t(`own.set.followUp.${mode}`),
          }))}
          onChange={(mode) => followUp.set(mode)}
          testid="settings-follow-up"
        />
      </Setting>
      {/* 10 §3.8: the service's 에이전트 방식 and 지시문 for new conversations. */}
      <HarnessDefaultSetting />
      {/* 5.1 기본 대화 폴더 and 18.3 폴더 열기 시작 위치, on this PC's service. */}
      <FolderSettings />
      {/* 19.14 `간단 / 보통 / 자세히` */}
      <TimelineDetailSetting />
      {/* 7.2 `한도 표시`: 남은 양(기본) / 쓴 양, 계정 페이지·목록의 자세히 / 간단히 / 아주 간단히 */}
      <LimitDisplaySetting />
      {/* 4.5 대화 보기: the header `보기` menu's choices */}
      <ChatViewSetting />
      <WebNotificationSetting />
    </div>
  )
}

/** `화면 크기`: the title bar bubble's control; its changes do not flash that bubble. */
function ZoomSetting() {
  const zoom = useHost().window?.zoom
  if (!zoom) return null
  const i18n = useI18n()
  const st = useSettingsSectionsText()
  return (
    <Setting title={i18n.t("own.zoom.label")} note={st("own.zoom.note")}>
      <ZoomControl state={zoomState(zoom)} quiet testid="settings-zoom" />
    </Setting>
  )
}

/**
 * 03 §9: request notifications need the browser's permission on the web (the desktop host notifies natively). Asked
 * only from this button, never on its own.
 */
function WebNotificationSetting() {
  const i18n = useI18n()
  const st = useSettingsSectionsText()
  const host = useHost()
  const [permission, setPermission] = createSignal(
    typeof Notification === "function" ? Notification.permission : ("denied" as NotificationPermission),
  )
  return (
    <Show when={host.capabilities.osNotifications === "web"}>
      <Setting title={st("own.set.notify")} note={st("own.set.notify.note")}>
        <Show
          when={permission() === "default"}
          fallback={
            <span class="text-[12.5px] text-own-muted" data-testid="settings-notify-state" data-state={permission()}>
              {st(permission() === "granted" ? "own.set.notify.granted" : "own.set.notify.denied")}
            </span>
          }
        >
          <button
            type="button"
            class="own-target rounded-md border border-own-border px-2.5 py-1 text-[12.5px] hover:bg-own-hover"
            data-testid="settings-notify-allow"
            onClick={() => void Notification.requestPermission().then(setPermission, () => undefined)}
          >
            {st("own.set.notify.allow")}
          </button>
        </Show>
      </Setting>
    </Show>
  )
}

export function LayoutSettings() {
  const i18n = useI18n()
  const st = useSettingsSectionsText()
  const shell = useShell()
  const [done, setDone] = createSignal(false)
  return (
    <div class="flex flex-col" data-testid="settings-layout">
      {/* 03 §4.1.1: the device default; each window can switch on its tab row (and the palette). */}
      <Setting title={st("own.set.workspaceView")} note={st("own.set.workspaceViewNote")}>
        <Segmented
          label={st("own.set.workspaceView")}
          value={shell.panes.deviceMode()}
          options={[
            { value: "split", label: st("own.set.workspaceView.split") },
            { value: "tabs", label: st("own.set.workspaceView.tabs") },
          ]}
          onChange={(mode) => shell.setPaneMode(mode, "device")}
          testid="settings-workspace-view"
        />
      </Setting>
      <Setting title={st("own.set.terminalPlacement")} note={st("own.set.terminalPlacementNote")}>
        <Segmented
          label={st("own.set.terminalPlacement")}
          value={shell.layout.state.terminalPlacement}
          options={[
            { value: "tab", label: st("own.set.terminalTab") },
            { value: "bottom", label: st("own.set.terminalBottom") },
          ]}
          onChange={(placement) => shell.layout.setTerminalPlacement(placement)}
        />
      </Setting>
      <Setting title={st("own.set.resetWidths")} note={st("own.set.resetWidthsNote")}>
        <button
          type="button"
          class="own-btn"
          data-size="sm"
          onClick={() => {
            const tier = TIER_LAYOUT[shell.tier()]
            shell.workspaceLayout.update({ sidebarWidth: tier.sidebar, panelWidth: tier.panel, notesWidth: 340 })
            setDone(true)
          }}
        >
          {st(done() ? "own.set.done" : "own.set.reset")}
        </button>
      </Setting>
    </div>
  )
}

const GUARD_LABEL = { ok: "own.set.guardOk", skew: "own.set.guardSkew", unmanaged: "own.set.guardUnmanaged" } as const

export function ServerSettings() {
  const data = useData()
  const host = useHost()
  const i18n = useI18n()
  const st = useSettingsSectionsText()
  const local = data.local()
  const own = local.own
  const status = createStatus()
  const [service] = createResource(() => host.service?.status().catch(() => undefined))
  const health = () => own.state.health
  const mode = () => service()?.mode
  const restart = async () => {
    status.clear()
    const result = await host.service?.restart({ force: false }).catch(() => undefined)
    if (!result) return status.error(i18n.t("own.desktop.startFailed"))
    if (result.ok) return status.ok(st("own.banner.restarting"))
    status.error(
      result.refused === "session_running" ? i18n.t("own.desktop.launcherRefused") : i18n.t("own.desktop.startFailed"),
    )
  }
  const diagnostics = () =>
    JSON.stringify(
      performance
        .getEntriesByType("mark")
        .filter((entry) => entry.name.startsWith("own:"))
        .map((entry) => ({ name: entry.name, at: Math.round(entry.startTime) })),
    )
  return (
    <div class="flex flex-col" data-testid="settings-server">
      <p class="m-0 mb-3 text-[12.5px] text-own-muted">{st("own.set.server.lead")}</p>
      <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[13px]">
        <dt class="text-own-muted">{st("own.set.address")}</dt>
        <dd class="own-mono m-0 break-all">{local.entry()?.baseUrl ?? "—"}</dd>
        <dt class="text-own-muted">{i18n.t("own.set.version")}</dt>
        <dd class="own-mono m-0">
          {health()?.version ?? "—"} <span class="text-own-faint">({health()?.buildId ?? "—"})</span>
        </dd>
        <dt class="text-own-muted">{i18n.t("own.set.trustMode")}</dt>
        <dd class="m-0">
          {mode()
            ? i18n.t(mode() === "untrusted" ? "own.set.untrusted" : "own.set.trusted")
            : i18n.t("own.conf.unknown")}
        </dd>
        <dt class="text-own-muted">{st("own.set.connection")}</dt>
        <dd class="m-0" data-testid="server-connection">
          {i18n.t(
            local.connection.status() === "connected"
              ? "own.nav.server.connected"
              : local.connection.status() === "reconnecting"
                ? "own.nav.server.offline"
                : "own.nav.server.connecting",
          )}
        </dd>
        <dt class="text-own-muted">{i18n.t("own.set.guard")}</dt>
        <dd class="m-0">{health() ? i18n.t(GUARD_LABEL[health()!.guard]) : i18n.t("own.conf.unknown")}</dd>
        <dt class="text-own-muted">{st("own.set.vault")}</dt>
        <dd class="m-0">
          {health()?.vault === "ok"
            ? st("own.set.vaultOk")
            : health()?.vault === "unavailable"
              ? i18n.t("own.acct.err.vault")
              : "—"}
          <Show when={health()?.vaultBackend}>
            {(backend) => (
              <span class="own-mono ml-2 text-own-faint">
                {backend().name} {backend().version}
              </span>
            )}
          </Show>
        </dd>
      </dl>
      <div class="mt-4 flex flex-wrap gap-2">
        <button type="button" class="own-btn" data-size="sm" onClick={() => void own.resync()}>
          {st("own.set.reconnect")}
        </button>
        <Show when={host.capabilities.serviceControl && host.service}>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            title={st("own.desktop.restartConfirm", { mode: mode() ?? "trusted" })}
            onClick={() => void restart()}
          >
            {st("own.desktop.restartService")}
          </button>
        </Show>
      </div>
      <Show when={!host.capabilities.serviceControl && !mode()}>
        <p class="m-0 mt-2 text-[12px] text-own-faint">{st("own.set.restartBoth")}</p>
      </Show>
      {/* Command text, the performance marks and the open locations matter only when something is wrong. */}
      <details class="mt-4 text-[12.5px]" data-testid="settings-server-troubleshoot">
        <summary class="own-target cursor-pointer text-own-muted">{st("own.set.troubleshoot")}</summary>
        <div class="mt-2 flex flex-wrap gap-2">
          <Show when={!(host.capabilities.serviceControl && host.service)}>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              onClick={() => void copyText(mode() === "untrusted" ? "own restart --untrusted" : "own restart")}
            >
              {i18n.t("own.state.copyCommand")}: own restart{mode() === "untrusted" ? " --untrusted" : ""}
            </button>
          </Show>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            onClick={() =>
              void copyText(diagnostics()).then((ok) => (ok ? status.ok(i18n.t("own.acct.copied")) : undefined))
            }
          >
            {st("own.set.copyDiagnostics")}
          </button>
        </div>
        <Show when={health()?.locations?.length}>
          <section class="own-psec">
            <div class="own-psec-head">
              <h2>{st("own.set.locations")}</h2>
            </div>
            <ul class="m-0 flex list-none flex-col gap-1 p-0 text-[12.5px]">
              <For each={health()!.locations}>
                {(location) => (
                  <li class="flex items-center gap-2">
                    <span class="own-mono min-w-0 flex-1 truncate" title={location.directory}>
                      {location.directory}
                    </span>
                    <Tag tone={location.allowlist === "ok" ? "ok" : "danger"}>
                      {location.allowlist === "ok" ? i18n.t("own.set.trustOk") : st("own.set.blocked")}
                    </Tag>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </details>
      <StatusLine status={status} />
    </div>
  )
}

/** Only with desktop capabilities (16.7): OS notifications, the editor. The zoom is 일반's (`화면 크기`). */
export function DesktopSettings() {
  const host = useHost()
  const i18n = useI18n()
  const st = useSettingsSectionsText()
  const status = createStatus()
  return (
    <div class="flex flex-col" data-testid="settings-desktop">
      {/* 05 §7.3: the window's X and the two quits, with the shell's tray. */}
      <Show when={host.app}>{(app) => <QuitSettings app={app()} />}</Show>
      <Show when={host.capabilities.osNotifications !== "none"}>
        <Setting title={st("own.set.osNotifications")} note={st("own.set.osNotificationsNote")}>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            onClick={() => {
              host.notify?.({
                title: st("own.set.testNotificationTitle"),
                body: st("own.set.testNotificationBody"),
              })
              status.ok(st("own.set.testNotificationSent"))
            }}
          >
            {st("own.set.testNotification")}
          </button>
        </Setting>
      </Show>
      {/* 19.5 `에디터에서 열기`: which app the desktop host opens files with (local server only, files/editor.ts). */}
      <Show when={host.capabilities.openInApp}>
        <EditorSetting />
      </Show>
      <StatusLine status={status} />
    </div>
  )
}

/** 설정 > 데스크톱 앱 `창을 닫으면` (트레이로 숨기기 by default) and `종료` (앱 종료, 완전 종료…), 05 §7.3. */
function QuitSettings(props: { readonly app: HostApp }) {
  const text = useQuitSettingsText()
  const [action, setAction] = createSignal<CloseAction>("tray")
  void props.app.closeAction().then(setAction, () => undefined)
  return (
    <>
      <Setting title={text("own.quit.close")} note={text("own.quit.close.note")}>
        <Segmented
          label={text("own.quit.close")}
          value={action()}
          options={(["tray", "quit"] as const).map((value) => ({ value, label: text(`own.quit.close.${value}`) }))}
          onChange={(value) => {
            setAction(value)
            void props.app.setCloseAction(value).then(setAction, () => undefined)
          }}
          testid="settings-close-action"
        />
      </Setting>
      <Setting title={text("own.quit.title")} note={text("own.quit.note")}>
        <QuitButtons />
      </Setting>
    </>
  )
}

/** 설정 > 데스크톱 "에디터 선택" (03 §5.7, 19.5): an app name the desktop host resolves or a full path; saved on Enter/blur. */
function EditorSetting() {
  const i18n = useI18n()
  const st = useSettingsSectionsText()
  const [draft, setDraft] = createSignal(editorPreference.get())
  const commit = () => {
    editorPreference.set(draft())
    setDraft(editorPreference.get())
  }
  return (
    <Setting title={st("own.set.editor")} note={st("own.set.editorNote")}>
      <div class="w-[220px]">
        <TextField
          label={st("own.set.editor")}
          hideLabel
          value={draft()}
          onValue={setDraft}
          onEnter={commit}
          onBlur={commit}
          placeholder="code"
          spellcheck={false}
          autocomplete="off"
          testid="settings-editor"
        />
      </div>
    </Setting>
  )
}

/** Desktop settings are visible only when the host has at least one of its capabilities (16.7). */
export function hasDesktopSettings(host: ReturnType<typeof useHost>) {
  return (
    host.capabilities.osNotifications === "native" ||
    host.capabilities.keepScreenAwake ||
    host.capabilities.openInApp ||
    !!host.app
  )
}

export function Setting(props: { readonly title: string; readonly note?: string; readonly children: unknown }) {
  return (
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-own-border py-3">
      <div class="min-w-[220px] flex-1">
        <b class="block text-[13.5px] font-semibold">{props.title}</b>
        <Show when={props.note}>
          <span class="text-[12px] text-own-muted">{props.note}</span>
        </Show>
      </div>
      {props.children as never}
    </div>
  )
}
