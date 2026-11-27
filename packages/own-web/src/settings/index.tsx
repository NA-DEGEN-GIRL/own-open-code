// Settings module entry (03 §5.7, owner: settings), lazy for /settings/:section (20.2 R5). A section list in five groups
// (기본 / 모델·계정 / 에이전트 / 연결 / 고급, routes.ts SETTINGS_GROUPS) with a one-line hint per page, and the page of
// the route. Heavy pages (자동 압축, 출력 상한, 플러그인, 자동 전환, 프리셋, 팀 모드, 승인·권한, 웹 검색, 이미지 만들기, 스킬,
// MCP 서버, 에이전트 방식, 확장) are their own lazy chunks.
// Gating (16.7): `데스크톱 앱` only with desktop capabilities, `휴대폰·다른 PC` and `다른 도구의 대화` only in PC windows
// (`auth` is not "device": other tools' files are this PC's, 09 §5.5); `계정 →` (first in 모델·계정) links to /accounts.
// 승인·권한 is the requests module's page (18.8), MCP 서버 the mcp module's (18.14, on the project on screen), 다른 도구의
// 대화 the import module's (09 §6). The hint shows under the label in the stacked list and as the link's title beside
// a page; it stays out of the link's name (aria-describedby).
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Suspense,
  Switch,
} from "solid-js"
import { useData } from "@/data"
import { useDiscoverText } from "@/discover/strings"
import { useHost } from "@/host"
import { useI18n, type I18nKey } from "@/i18n"
import { manualBase, openManual } from "@/manual"
import { SettingsManualLink } from "@/manual/link"
import { activeDirectory, activePlace } from "@/projects/active"
import { RouteLink, useRouter } from "@/routing/router"
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsSection } from "@/routing/routes"
import { DesktopSettings, GeneralSettings, hasDesktopSettings, LayoutSettings, ServerSettings } from "./sections"
import { navTarget, settingsLayout } from "./layout"
import { useSettingsSectionsText } from "./sections-strings"
import { useShell } from "@/shell/context"
import "./settings.css"

const CompactionSettings = lazy(() => import("./compaction"))
// 02 §4.9: the main reply's output limit (이 값을 넘기지 않기 / 출력 상한 보내지 않기).
const OutputLimitSettings = lazy(() => import("./output-limit"))
// US5, IM: own's image tool (02 §9.6), off unless the user turns it on (`policy.imageGenerate`), and its setting. A page
// of its own since IS (2026-11-08); it was a part of 컴퓨터 사용 (실험) before.
const ImageToolSettings = lazy(() => import("./image-tool"))
// BRW: 내 브라우저 사용 (실험), OpenCode's Browse through the user's own browser; off by default.
const BrowseSettings = lazy(() => import("@/browse/settings"))
const PluginSettings = lazy(() => import("./plugins"))
const PolicySettings = lazy(() => import("./policy"))
// 07 §7.1: provider-group tabs, the new-session default model, ★ and the preset list, ultra caps, start preset.
const PresetSettings = lazy(() => import("./presets"))
// 06 §9.8: the team's policy, the commands owners run without asking, thresholds and other tools' path patterns, on the
// team the route names (`/settings/team/<serverKey>/<teamID>`, `openTeamSettings`).
const TeamSettings = lazy(() => import("./team"))
const ApprovalSettings = lazy(() => import("@/requests/settings"))
// 10 §3.11: what each 에이전트 방식 sends, own's changes and the user's 내 지시문.
const PromptSettings = lazy(() => import("@/harness/prompt-page"))
const McpSettings = lazy(() => import("@/mcp/settings"))
// GH (2026-10-31): GitHub accounts, which one each project, team area and conversation uses, tools and git's logins.
const GitHubSettings = lazy(() => import("@/github/settings"))
// SM (2026-10-24): the skills core loads in the project on screen, removing own-import's copies, and the import view.
const SkillsSettings = lazy(() => import("@/skills/settings"))
const RemoteSettings = lazy(() => import("@/remote/settings"))
// M1 (05 §13.5, 03 §21.2): gateway, pairing (QR + SAS) and the device list.
const DevicesSettings = lazy(() => import("@/pairing/settings"))
// P7: the palette module's shortcut page (rebinding + conflict audit, 03 §10) and the Windows shell page (19.8).
const ShortcutSettings = lazy(() => import("@/palette/shortcut-settings"))
const ShellSettings = lazy(() => import("./shell"))
// 실험 > 컴퓨터 사용 (01 §10.2): the computer module's panel (status, Stop, reset, audit).
const ComputerSettings = lazy(() => import("@/computer/panel"))
// 09 §6: where own.import looks (`sources.list`, `찾을 곳 더하기`) and `사이드바에 보이기`.
const ImportSettings = lazy(() => import("@/import/settings"))
// 17 §8.1: the extensions creator mode made (own.creator), this PC's windows only.
const CreatorSettings = lazy(() => import("@/creator/settings"))
// 02 §3.9, 03 §5.7.4: voice input (on/off, service, language, voice-only keys, shortcut, minutes).
const VoiceSettings = lazy(() => import("@/voice/settings"))
// 03 §18.2 (WM 2026-10-19): the web search service, its cost and where queries go (was a section of 승인·권한).
const WebSearchSettings = lazy(() => import("@/websearch/settings"))
// UPD (05 §20): the outside programs own runs on this PC, their versions and their official updates.
const ToolUpdateSettings = lazy(() => import("@/tool-updates/settings"))

export interface SettingsPageProps {
  readonly section: SettingsSection
}

export default function SettingsPage(props: SettingsPageProps) {
  const i18n = useI18n()
  const discover = useDiscoverText()
  const host = useHost()
  const data = useData()
  const shell = useShell()
  const words = useSettingsSectionsText()
  // MUX (2026-11-06): what this window cannot change is listed apart, under `PC에서 바꾸는 설정`: on a device the pages
  // of this PC's windows only, and on a phone the layout and keyboard pages, which do nothing there.
  const pcOnly = createMemo(() =>
    SETTINGS_SECTIONS.filter((section) => {
      if (section === "devices" || section === "import" || section === "creator" || section === "updates")
        return data.local().entry()?.auth === "device"
      return shell.mode().sidebarMode === "list" && (section === "layout" || section === "shortcuts")
    }),
  )
  const visible = createMemo(() =>
    SETTINGS_SECTIONS.filter((section) => {
      if (pcOnly().includes(section)) return false
      if (section === "desktop") return hasDesktopSettings(host)
      return true
    }),
  )
  const available = () => visible().includes(props.section)
  /** The groups with their sections this window shows; a group left empty is not shown. */
  const groups = createMemo(() =>
    SETTINGS_GROUPS.map((group) => ({
      id: group.id,
      accounts: "accounts" in group,
      sections: group.sections.filter((section) => visible().includes(section)),
    })).filter((group) => group.accounts || group.sections.length > 0),
  )
  const router = useRouter()
  const teamTarget = () => {
    const route = router.route()
    return route.name === "settings" ? route.team : undefined
  }
  // The window width until the first measurement: the main column is never wider, so a phone starts stacked.
  const [width, setWidth] = createSignal(window.innerWidth)
  const layout = () => settingsLayout(width())
  const list = () => {
    const route = router.route()
    return route.name === "settings" && route.list === true
  }
  const view = () => (layout() === "stacked" && list() ? "list" : "page")
  /** Beside a page the hint is the link's tooltip; the stacked list shows it under the label instead. */
  const hintTitle = (key: I18nKey) => (layout() === "split" ? i18n.t(key) : undefined)
  let root!: HTMLElement
  let nav: HTMLElement | undefined
  let content: HTMLDivElement | undefined
  let title: HTMLHeadingElement | undefined
  onMount(() => {
    setWidth(root.clientWidth)
    const observer = new ResizeObserver(() => setWidth(root.clientWidth))
    observer.observe(root)
    onCleanup(() => observer.disconnect())
  })
  // A new section starts at its top and shows its list item. Stacked, focus follows the drill-down: into the page's
  // title, and back out onto the list item of the page just left.
  createEffect(
    on(
      () => [props.section, view()] as const,
      (_, previous) => {
        if (content) content.scrollTop = 0
        nav?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" })
        if (!previous || layout() !== "stacked") return
        if (view() === "page") return title?.focus()
        nav?.querySelector<HTMLElement>(`[href="/settings/${previous[0]}"]`)?.focus()
      },
    ),
  )
  const step = (event: KeyboardEvent) => {
    const links = Array.from(nav?.querySelectorAll<HTMLElement>(".own-settings-link") ?? [])
    const next = navTarget(event.key, links.indexOf(document.activeElement as HTMLElement), links.length)
    if (next === undefined) return
    event.preventDefault()
    links[next]?.focus()
  }
  return (
    <section
      ref={root}
      class="own-settings"
      data-testid="page-settings"
      data-section={props.section}
      data-layout={layout()}
      data-view={view()}
    >
      <Show when={layout() === "split" || view() === "list"}>
        <nav ref={nav} class="own-settings-nav" aria-label={i18n.t("own.page.settings")} data-testid="settings-nav">
          <ul onKeyDown={step}>
            <For each={groups()}>
              {(group) => (
                <li class="own-settings-group" data-testid={`settings-group-${group.id}`}>
                  <p class="own-settings-group-title" id={`own-settings-group-${group.id}`}>
                    {i18n.t(`own.settings.group.${group.id}`)}
                  </p>
                  <ul role="group" aria-labelledby={`own-settings-group-${group.id}`}>
                    <Show when={group.accounts}>
                      <li>
                        <RouteLink
                          to={{ name: "accounts" }}
                          class="own-settings-link own-target"
                          title={hintTitle("own.settings.accounts.hint")}
                          aria-describedby="own-settings-hint-accounts"
                          data-testid="settings-accounts-link"
                        >
                          <span class="own-settings-text">
                            <span>{i18n.t("own.nav.accounts")} →</span>
                            <span class="own-settings-hint" id="own-settings-hint-accounts" aria-hidden="true">
                              {i18n.t("own.settings.accounts.hint")}
                            </span>
                          </span>
                        </RouteLink>
                      </li>
                    </Show>
                    <For each={group.sections}>
                      {(section) => (
                        <li>
                          <RouteLink
                            to={{ name: "settings", section }}
                            class="own-settings-link own-target"
                            title={hintTitle(`own.settings.${section}.hint`)}
                            aria-describedby={`own-settings-hint-${section}`}
                            aria-current={view() === "page" && props.section === section ? "page" : undefined}
                            data-testid={`settings-nav-${section}`}
                          >
                            <span class="own-settings-text">
                              <span>{i18n.t(`own.settings.${section}`)}</span>
                              <span class="own-settings-hint" id={`own-settings-hint-${section}`} aria-hidden="true">
                                {i18n.t(`own.settings.${section}.hint`)}
                              </span>
                            </span>
                          </RouteLink>
                        </li>
                      )}
                    </For>
                  </ul>
                </li>
              )}
            </For>
            {/* MUX: named, not linked, so a phone knows the setting exists and where it is changed. */}
            <Show when={pcOnly().length > 0}>
              <li class="own-settings-group" data-testid="settings-group-pc-only">
                <p class="own-settings-group-title" id="own-settings-group-pc-only">
                  {words("own.set.pcOnly.title")}
                </p>
                <ul role="group" aria-labelledby="own-settings-group-pc-only">
                  <For each={pcOnly()}>
                    {(section) => (
                      <li class="own-settings-link own-settings-pc-only" data-testid={`settings-pc-only-${section}`}>
                        <span class="own-settings-text">
                          <span>
                            {section === "creator"
                              ? words("own.set.pcOnly.creator")
                              : i18n.t(`own.settings.${section}`)}
                          </span>
                          <span class="own-settings-hint">{words("own.set.pcOnly.note")}</span>
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </li>
            </Show>
            {/* 03 §4.3.1: the user manual (in-app, offline). */}
            <Show when={manualBase()}>
              <li class="own-settings-nav-manual">
                <button
                  type="button"
                  class="own-settings-link own-target w-full cursor-pointer border-0 bg-transparent text-left font-[inherit]"
                  data-testid="settings-manual-link"
                  onClick={() => openManual("settings")}
                >
                  {discover("own.discover.manual")} ↗
                </button>
              </li>
            </Show>
          </ul>
        </nav>
      </Show>
      <Show when={view() === "page"}>
        <div ref={content} class="own-settings-content" data-testid="settings-content">
          <div class="own-settings-body">
            <Show when={layout() === "stacked"}>
              <RouteLink
                to={{ name: "settings", section: "general", list: true }}
                class="own-settings-back own-target"
                data-testid="settings-back"
              >
                ← {i18n.t("own.page.settings")}
              </RouteLink>
            </Show>
            <h1 ref={title} class="own-settings-title" tabIndex={-1}>
              {i18n.t(`own.settings.${props.section}`)}
            </h1>
            <SettingsManualLink section={props.section} />
            <Show when={available()} fallback={<p class="own-placeholder px-0">{i18n.t("own.set.unavailableHere")}</p>}>
              <Suspense fallback={<p class="own-placeholder px-0">{i18n.t("own.shell.loading")}</p>}>
                <Switch>
                  <Match when={props.section === "general"}>
                    <GeneralSettings />
                  </Match>
                  <Match when={props.section === "layout"}>
                    <LayoutSettings />
                  </Match>
                  <Match when={props.section === "policy"}>
                    <PolicySettings />
                  </Match>
                  <Match when={props.section === "presets"}>
                    <PresetSettings />
                  </Match>
                  <Match when={props.section === "team"}>
                    <TeamSettings target={teamTarget()} />
                  </Match>
                  <Match when={props.section === "compaction"}>
                    <CompactionSettings />
                  </Match>
                  <Match when={props.section === "output"}>
                    <OutputLimitSettings />
                  </Match>
                  <Match when={props.section === "plugins"}>
                    <PluginSettings />
                  </Match>
                  <Match when={props.section === "import"}>
                    <ImportSettings />
                  </Match>
                  <Match when={props.section === "approval"}>
                    <ApprovalSettings />
                  </Match>
                  <Match when={props.section === "websearch"}>
                    <WebSearchSettings />
                  </Match>
                  <Match when={props.section === "image"}>
                    <ImageToolSettings />
                  </Match>
                  <Match when={props.section === "browse"}>
                    <BrowseSettings />
                  </Match>
                  <Match when={props.section === "harness"}>
                    <PromptSettings />
                  </Match>
                  <Match when={props.section === "mcp"}>
                    <McpSettings directory={activeDirectory(data.local(), router.route())} />
                  </Match>
                  <Match when={props.section === "skills"}>
                    <SkillsSettings directory={activeDirectory(data.local(), router.route())} />
                  </Match>
                  <Match when={props.section === "github"}>
                    <GitHubSettings place={activePlace(data, router.route())} />
                  </Match>
                  <Match when={props.section === "server"}>
                    <ServerSettings />
                  </Match>
                  <Match when={props.section === "remote"}>
                    <RemoteSettings />
                  </Match>
                  <Match when={props.section === "shell"}>
                    <ShellSettings />
                  </Match>
                  <Match when={props.section === "voice"}>
                    <VoiceSettings />
                  </Match>
                  <Match when={props.section === "shortcuts"}>
                    <ShortcutSettings />
                  </Match>
                  <Match when={props.section === "desktop"}>
                    <DesktopSettings />
                  </Match>
                  <Match when={props.section === "devices"}>
                    <DevicesSettings />
                  </Match>
                  <Match when={props.section === "creator"}>
                    <CreatorSettings />
                  </Match>
                  <Match when={props.section === "updates"}>
                    <ToolUpdateSettings />
                  </Match>
                  <Match when={props.section === "experimental"}>
                    <ComputerSettings />
                    {/* IS: where the image tool went, for a user who looks for it here. */}
                    <RouteLink
                      to={{ name: "settings", section: "image" }}
                      class="own-target mt-4 inline-block text-[12.5px] text-own-accent-text no-underline hover:underline"
                      data-testid="settings-image-moved"
                    >
                      {words("own.set.imageMoved")} →
                    </RouteLink>
                  </Match>
                </Switch>
              </Suspense>
            </Show>
          </div>
        </div>
      </Show>
    </section>
  )
}
