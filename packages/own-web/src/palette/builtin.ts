// Built-in palette commands (03 §3 "명령 팔레트: 세션 이동 · 모델 @ 계정 전환 · 새 세션 · 폴더 열기 · 패널 탭 이동 ·
// 터미널 · 리뷰 · 워크트리 · 화면 이동 · 테마", 19.15 "터미널·리뷰·워크트리·패널 탭·자동 압축·승인 모드"). Every action
// goes through the module that owns it (switcher, projects, commands, revert, mcp, terminal intents, shell), so the
// palette never decides anything itself:
//   - model @ account only opens the switcher (with the account preselected); the switcher estimates the cost and
//     asks (03 §5.2 "어디서 열어도 같은 팝오버"). Nothing here calls switch.apply.
//   - the approval mode is never set from here: the command opens the menu, like Ctrl+Shift+A (03 §10).
// Actions that exist only as a shortcut handler run through the registry (`runShortcut`), and every other registered
// global shortcut is listed too, so features that land later appear without palette changes. Lives in the lazy chunk.
import { useTheme } from "@opencode/ui/theme/context"
import { createEffect, createMemo } from "solid-js"
import { useCommandActions, type CommandContext } from "@/commands"
import { activeReset, resetContext, resetText, undoReset } from "@/context-reset"
import { sendKey } from "@/composer/send-key"
import { changeSendKey, sendKeyName } from "@/composer/send-key-menu"
import { sendKeyText, type SendKeyKey } from "@/composer/send-key-strings"
import { LOCAL, useData, type ServerKey, type ServerRuntime } from "@/data"
import { useForkCommands } from "@/forking"
import type { FeatureText } from "@/queue/text"
import { useHost } from "@/host"
import { translate, useI18n, type I18nKey, type I18nParams, type Locale } from "@/i18n"
import { ko } from "@/i18n/ko"
import { useShortcuts } from "@/keyboard"
import { DEFAULT_KEYMAP, type ShortcutID } from "@/keyboard/keymap"
import { openMcpList } from "@/mcp"
import { activeDirectory, baseName, mergeRecent, openedFolders, openProject, resolveProject } from "@/projects"
import { useRevertCommands } from "@/revert"
import { useRouter } from "@/routing/router"
import { requestSettingsIntent, type SettingsIntent } from "@/settings/intent"
import { routeServer, SETTINGS_SECTIONS, type Route, type SettingsSection } from "@/routing/routes"
import { useShell } from "@/shell/context"
import { COLOR_SCHEMES } from "@/shell/theme-default"
import { setNewSessionTarget } from "@/sidebar/target"
import { remoteStore } from "@/servers/active"
import { openNewChat } from "@/servers/new-chat"
import { openSwitcher, showToast } from "@/switcher"
import { currentRef } from "@/switcher/session"
import { requestNewTerminal } from "@/terminal/intents"
import type { PaletteCommand, PaletteGroup } from "./registry"
import { hasShortcutHandler, runShortcut } from "./run-shortcut"
import { paletteText, type PaletteKey } from "./strings"
import { inFocusedPane } from "@/shell/pane-context"

/** Sessions shown when nothing is typed; all loaded sessions are searchable. */
export const RECENT_SESSIONS = 8

/** Ids a built-in command covers, so the generic shortcut list does not repeat them. */
const COVERED: ReadonlySet<ShortcutID> = new Set([
  "palette.open",
  "switcher.open",
  "sidebar.toggle",
  "panel.toggle",
  "panel.review",
  "panel.files",
  "panel.terminal",
  "panel.browser",
  "panel.accounts",
  "terminal.new",
  "session.new",
  "folder.open",
  "history.back",
  "history.forward",
  "composer.focus",
  "mcp.list",
  "settings.open",
  "shortcuts.help",
  "session.previous",
  "session.next",
  "session.info",
  // The feature commands' `보관` / `보관 해제` carries it (shell/palette-commands.tsx).
  "session.archive",
  "approval.menu",
  // Only meaningful while a dock is up; its guard would make the command a no-op otherwise.
  "dock.focus",
  // src/ideas registers `아이디어 적기` with its keys and words.
  "idea.capture",
  // src/app-quit registers `완전 종료…` with its keys (desktop only).
  "app.quitAll",
])

/** Group of a shortcut-only command. */
const SHORTCUT_GROUP: Partial<Record<ShortcutID, PaletteGroup>> = {
  "agent.cycle": "agent",
  "message.previous": "sessionOps",
  "message.next": "sessionOps",
  "session.find": "sessionOps",
  "context.addSelection": "sessionOps",
  "file.open": "navigate",
  "zoom.in": "view",
  "zoom.out": "view",
  "zoom.reset": "view",
  "view.chatOnly": "view",
  "pane.splitRight": "view",
  "pane.splitDown": "view",
  "pane.close": "view",
  "pane.focus1": "navigate",
  "pane.focus2": "navigate",
  "pane.focus3": "navigate",
  "pane.focus4": "navigate",
  "pane.next": "navigate",
  "pane.previous": "navigate",
}

/**
 * Hidden words a settings page is found by (both languages, and the words people type: 하네스 finds 에이전트 방식,
 * 휴대폰 finds 휴대폰·다른 PC).
 */
export const SECTION_WORDS: Record<SettingsSection, string> = {
  general:
    "general theme language zoom 일반 테마 다크 어둡게 밝게 언어 화면 크기 확대 축소 배율 밀도 한도 표시 알림 대화 보기 에이전트 방식 하네스 harness codex pi deepseek dsh omo ultrawork ulw 울트라워크 보내는 키 전송 줄바꿈 enter send key newline 기본 대화 폴더 폴더 없이 폴더 열기 시작 위치 default folder",
  layout: "layout panel terminal placement 화면 배치 레이아웃 분할 나란히 탭 터미널 위치 폭",
  policy: "switch policy 자동 전환 전환 정책 한도 전환 비용 묻기",
  presets: "presets preset subagents delegation ultra 프리셋 하위 에이전트 서브에이전트 위임 울트라",
  team: "team mode areas owners commands thresholds patterns 팀 모드 영역 담당 반영",
  compaction: "auto compaction compact 자동 압축 요약 문맥",
  output: "output limit max tokens max_tokens reply length 출력 상한 출력 한도 최대 토큰 답 길이 잘림 끊김",
  approval:
    "approval permissions 승인 권한 허용 항상 허용 묻기 읽기 전용 전체 허용 protected secrets ssh wallet 에이전트가 못 여는 파일 폴더 보호 비밀 지갑",
  shell: "shell terminal pwsh powershell git bash cmd 셸 파워셸 터미널",
  skills: "skills skill SKILL.md 스킬 가져오기 설치 import install url codex claude code 다른 도구 작업 방법",
  mcp: "mcp servers tools add install import 도구 서버 외부 도구 추가 설치 가져오기 연결 시험 codex claude code",
  plugins: "plugins 플러그인 claude 구독 승인",
  creator: "extensions creator 확장 크리에이터 만들기",
  import: "other tools codex claude code conversations import 가져오기 다른 도구",
  updates: "updates update version claude code git lfs gh ripgrep 업데이트 버전 새 버전 최신",
  remote: "remote ssh hosts 원격 서버 호스트",
  github: "github 깃허브 계정 여러 계정 토큰 pat token account git push pull pr 이슈 issue",
  shortcuts: "shortcuts keybindings keys 단축키 키",
  voice: "voice input dictation microphone speech transcribe 음성 받아쓰기 마이크 음성 입력",
  server: "server connection service 서비스 상태 재시작 다시 시작 버전 연결",
  desktop:
    "desktop notifications editor tray quit 데스크톱 알림 에디터 트레이 종료 앱 종료 완전 종료 창 닫기 창을 닫으면",
  devices: "devices 휴대폰 핸드폰 폰 모바일 안드로이드 다른 pc 기기 qr 페어링 tailscale 게이트웨이 원격 접속",
  experimental: "experimental computer use 컴퓨터 사용 화면 조작 마우스 키보드 실험",
  // BRW: 내 브라우저 사용 (실험), OpenCode's Browse.
  browse: "browser browse chrome edge 브라우저 크롬 엣지 탭 로그인",
  // IS (2026-11-08): the image tool's own page (it was a part of 컴퓨터 사용 (실험)).
  image:
    "image generation generate picture gpt-image openai api key codex subscription 이미지 만들기 이미지 생성 그림 사진 이미지 도구 api 키 순서 구독으로 만들기",
  harness:
    "agent style harness prompt system prompt instructions 에이전트 방식 하네스 지시문 시스템 프롬프트 원본 개선판 내 지시문 codex pi deepseek dsh omo ultrawork ulw 울트라워크",
  websearch:
    "web search internet search service 웹 검색 인터넷 검색 서비스 웹검색 검색 엔진 chatgpt parallel exa tavily firecrawl tinyfish deepseek brave 무료 검색 여러 서비스 함께",
}

export function useBuiltinCommands(): () => readonly PaletteCommand[] {
  const data = useData()
  const host = useHost()
  const i18n = useI18n()
  const router = useRouter()
  const shell = useShell()
  const theme = useTheme()
  const registry = useShortcuts()
  // Compact and fork go through the forking module (19.12: `압축 중…` chip, failure banner, flags cleared on forks).
  const actions = useCommandActions({ overrides: useForkCommands() })
  const revert = useRevertCommands()

  const other = (): Locale => (i18n.locale() === "ko" ? "en" : "ko")
  /** Shared-catalog label, with the other language as a keyword. */
  const shared = (key: I18nKey, params?: I18nParams) => ({
    title: i18n.t(key, params),
    keywords: [translate(other(), key, params)],
  })
  const own = (key: PaletteKey, params?: I18nParams) => ({
    title: paletteText(i18n.locale(), key, params),
    keywords: [paletteText(other(), key, params)],
  })
  const text = (key: PaletteKey, params?: I18nParams) => paletteText(i18n.locale(), key, params)
  /** `own.set.sc.<id>` (03 §10 names); an id added later without a label shows the id. */
  const shortcutLabel = (id: ShortcutID) => {
    const key = `own.set.sc.${id}`
    return isCatalogKey(key) ? shared(key) : { title: id, keywords: [] }
  }

  /** The session or project the commands act on; pages keep none (they render over the session view). */
  const context = createMemo(() => {
    const route = router.route()
    const serverKey: ServerKey = routeServer(route)
    const runtime = data.get(serverKey) ?? data.local()
    const sessionID = route.name === "session" ? route.sessionID : undefined
    const directory = activeDirectory(runtime, route)
    return { route, runtime, serverKey: runtime.key, sessionID, directory } satisfies CommandContext & {
      route: Route
    }
  })
  // The agent list of the session's folder loads on first use (`/agent` does the same); the rows appear when it lands.
  createEffect(() => {
    const ctx = context()
    if (!ctx.sessionID || !ctx.directory) return
    const location = { directory: ctx.directory }
    if (!ctx.runtime.data.location.agent.list(location))
      void ctx.runtime.data.location.agent.sync(location).catch(() => undefined)
  })
  /** 03 §5.1 (2.2.6-own.16): `이 PC에서 새 대화` and `<호스트>에서 새 대화`, while SSH hosts exist. */
  const newChatCommands = (): PaletteCommand[] => {
    const store = remoteStore()
    if (!store?.state.order.length) return []
    const start = (serverKey: ServerKey) =>
      openNewChat({ serverKey, navigate, phone: shell.mode().sidebarMode === "list", local: data.local() })
    return [
      { id: "session.new.local", group: "navigate", ...own("own.palette.cmd.newChatLocal"), run: () => start(LOCAL) },
      ...store.state.order.flatMap((hostId): PaletteCommand[] => {
        const name = store.state.hosts[hostId]?.name
        if (!name) return []
        const label = own("own.palette.cmd.newChatOn", { host: name })
        return [
          {
            id: `session.new.host:${hostId}`,
            group: "navigate",
            ...label,
            keywords: [...label.keywords, "ssh remote host 원격 호스트 새 세션"],
            run: () => start(hostId),
          },
        ]
      }),
    ]
  }
  const composerAnchor = () => inFocusedPane('[data-testid="composer-switcher"]')
  const navigate = (route: Route) => router.navigate(route)
  /** An action that exists only as a shortcut handler; listed while one is registered. */
  const shortcutCommand = (id: ShortcutID, group: PaletteGroup): PaletteCommand[] =>
    hasShortcutHandler(registry, id)
      ? [{ id: `shortcut:${id}`, group, ...shortcutLabel(id), shortcut: id, run: () => void runShortcut(registry, id) }]
      : []

  return () => {
    const ctx = context()
    const runtime = ctx.runtime
    const sessionID = ctx.sessionID
    const onSessionOrHome = ctx.route.name === "session" || ctx.route.name === "home" || ctx.route.name === "project"

    const model: PaletteCommand[] = onSessionOrHome
      ? [
          {
            id: "switcher.open",
            group: "model",
            ...own("own.palette.cmd.switcher"),
            shortcut: "switcher.open",
            run: () => openSwitcher({ anchor: composerAnchor() }),
          },
          ...accountCommands(runtime, sessionID),
        ]
      : []

    const sessionOps: PaletteCommand[] = sessionID
      ? [
          {
            id: "session.compact",
            group: "sessionOps",
            ...own("own.palette.cmd.compact"),
            run: () => actions.compact(ctx),
          },
          ...resetCommands(runtime, sessionID),
          { id: "session.fork", group: "sessionOps", ...own("own.palette.cmd.fork"), run: () => actions.fork(ctx) },
          {
            id: "session.undo",
            group: "sessionOps",
            title: revert.undoLabel(),
            keywords: ["undo", "/undo"],
            run: () => void revert.undo(ctx.serverKey, sessionID),
          },
          {
            id: "session.redo",
            group: "sessionOps",
            title: revert.redoLabel(),
            keywords: ["redo", "/redo"],
            run: () => void revert.redo(ctx.serverKey, sessionID),
          },
          {
            id: "session.export",
            group: "sessionOps",
            ...own("own.palette.cmd.export"),
            run: () => actions.exportSession(ctx),
          },
          {
            id: "session.copyId",
            group: "sessionOps",
            ...own("own.palette.cmd.copyId"),
            detail: sessionID,
            run: () => copySessionID(sessionID),
          },
          ...shortcutCommand("session.info", "sessionOps"),
          ...agentCommands(runtime, ctx),
        ]
      : []

    const navigateGroup: PaletteCommand[] = [
      {
        id: "session.new",
        group: "navigate",
        ...shared("own.nav.newSession"),
        shortcut: "session.new",
        run: () => actions.newSession(ctx),
      },
      ...newChatCommands(),
      {
        id: "folder.open",
        group: "project",
        ...shortcutLabel("folder.open"),
        shortcut: "folder.open",
        run: () => void openProject(ctx.serverKey),
      },
      {
        id: "history.back",
        group: "navigate",
        ...shortcutLabel("history.back"),
        shortcut: "history.back",
        run: () => router.back(),
      },
      {
        id: "history.forward",
        group: "navigate",
        ...shortcutLabel("history.forward"),
        shortcut: "history.forward",
        run: () => router.forward(),
      },
      ...shortcutCommand("session.previous", "navigate"),
      ...shortcutCommand("session.next", "navigate"),
      {
        id: "composer.focus",
        group: "navigate",
        ...shortcutLabel("composer.focus"),
        shortcut: "composer.focus",
        run: () => document.getElementById("own-composer-input")?.focus(),
      },
      {
        id: "page.accounts",
        group: "navigate",
        ...own("own.palette.cmd.accounts"),
        run: () => navigate({ name: "accounts" }),
      },
      {
        id: "page.accountsAdd",
        group: "navigate",
        ...own("own.palette.cmd.addAccount"),
        run: () => navigate({ name: "accountsAdd" }),
      },
      {
        id: "page.limits",
        group: "navigate",
        ...own("own.palette.cmd.limits"),
        run: () => navigate({ name: "limits" }),
      },
    ]

    const tabs = shell.tabs()
    const panel: PaletteCommand[] = [
      {
        id: "panel.toggle",
        group: "panel",
        ...shortcutLabel("panel.toggle"),
        shortcut: "panel.toggle",
        run: () => shell.togglePanel(),
      },
      ...(shell.panelOpen()
        ? [
            {
              id: "panel.close",
              group: "panel",
              ...own("own.palette.cmd.closePanel"),
              run: () => shell.closePanel(),
            } satisfies PaletteCommand,
          ]
        : []),
      ...tabs.map((tab): PaletteCommand => {
        // 팀 룸 (06 §9.9) shows on team conversations only and has no shortcut of its own.
        if (tab === "team")
          return {
            id: "panel.team",
            group: "panel",
            ...shared("own.panel.teamCommand"),
            keywords: [...shared("own.panel.teamCommand").keywords, tab],
            run: () => shell.openTab(tab),
          }
        return {
          id: `panel.${tab}`,
          group: tab === "review" ? "review" : "panel",
          ...shortcutLabel(`panel.${tab}`),
          keywords: [...shortcutLabel(`panel.${tab}`).keywords, tab],
          shortcut: `panel.${tab}`,
          run: () => shell.openTab(tab),
        }
      }),
      {
        id: "sidebar.toggle",
        group: "panel",
        ...shortcutLabel("sidebar.toggle"),
        shortcut: "sidebar.toggle",
        run: () => shell.toggleSidebar(),
      },
    ]

    const placement = shell.layout.state.terminalPlacement
    const terminal: PaletteCommand[] = [
      // With the terminal under the conversation (4.7.3) the tab is gone: open the dock instead.
      ...(placement === "bottom"
        ? [
            {
              id: "terminal.open",
              group: "terminal",
              ...shared("own.panel.terminal"),
              shortcut: "panel.terminal",
              run: () => shell.openTerminal(),
            } satisfies PaletteCommand,
          ]
        : []),
      {
        id: "terminal.new",
        group: "terminal",
        ...shortcutLabel("terminal.new"),
        shortcut: "terminal.new",
        run: () => {
          shell.openTerminal()
          requestNewTerminal()
        },
      },
      {
        id: `terminal.placement:${placement === "tab" ? "bottom" : "tab"}`,
        group: "terminal",
        ...own("own.palette.cmd.terminalPlacement", {
          placement: text(placement === "tab" ? "own.palette.cmd.terminalBottom" : "own.palette.cmd.terminalTab"),
        }),
        run: () => shell.layout.setTerminalPlacement(placement === "tab" ? "bottom" : "tab"),
      },
    ]

    const projects = mergeRecent(runtime.sessions.state, openedFolders(runtime.key)).map(
      (project): PaletteCommand => ({
        id: `project.new:${runtime.key}:${project.directory}`,
        group: "project",
        ...own("own.palette.cmd.newSessionIn", { project: project.name }),
        detail: project.directory,
        run: () => startIn(runtime, project.directory, project.projectID),
      }),
    )

    const approval: PaletteCommand[] = shortcutCommand("approval.menu", "approval")
    const mcp: PaletteCommand[] = [
      {
        id: "mcp.list",
        group: "mcp",
        ...shortcutLabel("mcp.list"),
        shortcut: "mcp.list",
        run: () => void openMcpList(ctx.directory),
      },
    ]

    // 03 §18.2 (WM): `웹 검색 서비스 바꾸기` opens 설정 > 웹 검색, next to the page's own `설정: 웹 검색`.
    const webSearch: PaletteCommand = {
      id: "websearch.change",
      group: "settings",
      ...own("own.palette.cmd.webSearch"),
      keywords: [
        paletteText(other(), "own.palette.cmd.webSearch"),
        `websearch settings ${SECTION_WORDS.websearch} 웹 검색 설정`,
      ],
      run: () => navigate({ name: "settings", section: "websearch" }),
    }

    // SM (2026-10-24): adding or importing an MCP server and importing skills, each a step into its settings page. This
    // PC's windows only, like the actions themselves (`local`).
    const local = data.local()
    const intent = (
      id: string,
      key: PaletteKey,
      section: SettingsSection,
      value: SettingsIntent,
      words: string,
    ): PaletteCommand => ({
      id,
      group: "settings",
      ...own(key),
      keywords: [paletteText(other(), key), `${words} ${SECTION_WORDS[section]}`],
      run: () => {
        requestSettingsIntent(value)
        navigate({ name: "settings", section })
      },
    })
    const tools: PaletteCommand[] = [
      ...(local.rpc.allowed("mcp.save")
        ? [
            intent("mcp.add", "own.palette.cmd.mcpAdd", "mcp", "mcp.add", "mcp add install new server 추가 설치 새"),
            intent("mcp.import", "own.palette.cmd.mcpImport", "mcp", "mcp.import", "mcp import 가져오기 옮기기"),
          ]
        : []),
      // MH (04 §13 "MCP"): this PC's MCP servers on an SSH host, while there is one.
      ...(local.rpc.allowed("mcp.hosts.send") && (remoteStore()?.state.order.length ?? 0) > 0
        ? [
            intent(
              "mcp.hosts",
              "own.palette.cmd.mcpHosts",
              "mcp",
              "mcp.hosts",
              "mcp ssh host remote install 호스트 원격 서버 설치",
            ),
          ]
        : []),
      ...(local.imports.allowed("skills.import")
        ? [intent("skills.import", "own.palette.cmd.skillsImport", "skills", "skills.import", "skills import 가져오기")]
        : []),
    ]

    // 03 §4.3.1: one plain `설정 열기` (Ctrl+,) that every word for settings finds, besides one command per section.
    const openSettings: PaletteCommand = {
      id: "settings.open",
      group: "settings",
      ...own("own.palette.cmd.openSettings"),
      keywords: [
        paletteText(other(), "own.palette.cmd.openSettings"),
        "settings preferences options configuration 설정 환경설정 옵션 기본 설정",
      ],
      shortcut: "settings.open",
      run: () => navigate({ name: "settings", section: "general", list: true }),
    }
    const settings = visibleSections().map(
      (section): PaletteCommand => ({
        id: `settings:${section}`,
        group: section === "compaction" ? "compaction" : section === "approval" ? "approval" : "settings",
        ...own("own.palette.cmd.settings", { section: i18n.t(`own.settings.${section}`) }),
        keywords: [
          paletteText(other(), "own.palette.cmd.settings", { section: translate(other(), `own.settings.${section}`) }),
          `settings ${SECTION_WORDS[section]}`,
        ],
        shortcut: section === "shortcuts" ? "shortcuts.help" : undefined,
        run: () => navigate({ name: "settings", section }),
      }),
    )

    // 03 §4.6 보내는 키: one step to the other choice (the composer's `▾` and 설정 > 일반 have both).
    const nextSendKey = sendKey.value() === "enter" ? "modEnter" : "enter"
    const sendKeyIn =
      (locale: Locale): FeatureText<SendKeyKey> =>
      (key, params) =>
        sendKeyText.text(locale, key, params)
    const sendKeyHere = sendKeyIn(i18n.locale())
    const sendKeyCommand: PaletteCommand = {
      id: "composer.sendKey",
      group: "settings",
      title: sendKeyHere("own.sendKey.palette"),
      keywords: [
        sendKeyIn(other())("own.sendKey.palette"),
        "send key enter ctrl+enter newline 보내는 키 전송 줄바꿈 엔터",
      ],
      detail: sendKeyHere("own.sendKey.paletteDetail", {
        current: sendKeyName(sendKey.value(), sendKeyHere),
        next: sendKeyName(nextSendKey, sendKeyHere),
      }),
      run: () => changeSendKey(nextSendKey, sendKeyHere),
    }

    const view: PaletteCommand[] = [
      ...COLOR_SCHEMES.filter((scheme) => scheme !== theme.colorScheme()).map(
        (scheme): PaletteCommand => ({
          id: `theme:${scheme}`,
          group: "view",
          ...shared("own.shell.theme", { scheme: i18n.t(`own.shell.theme.${scheme}`) }),
          keywords: [
            translate(other(), "own.shell.theme", { scheme: translate(other(), `own.shell.theme.${scheme}`) }),
            `theme ${scheme}`,
          ],
          run: () => theme.setColorScheme(scheme),
        }),
      ),
      ...(["ko", "en"] as const)
        .filter((locale) => locale !== i18n.locale())
        .map(
          (locale): PaletteCommand => ({
            id: `language:${locale}`,
            group: "view",
            ...own("own.palette.cmd.language", { language: locale === "ko" ? "한국어" : "English" }),
            keywords: ["language locale 언어"],
            run: () => i18n.setLocale(locale),
          }),
        ),
    ]

    // Every other global shortcut that has a handler in this window (find, message navigation, zoom, agent cycle…).
    const generic = (Object.keys(registry.keymap) as ShortcutID[])
      .filter((id) => !COVERED.has(id) && DEFAULT_KEYMAP[id].scope === "global")
      .flatMap((id) => shortcutCommand(id, SHORTCUT_GROUP[id] ?? "shortcut"))

    return [
      ...model,
      ...sessionOps,
      ...navigateGroup,
      ...panel,
      ...terminal,
      ...projects,
      ...approval,
      ...mcp,
      openSettings,
      ...settings,
      webSearch,
      ...tools,
      sendKeyCommand,
      ...view,
      ...generic,
    ]

    function visibleSections() {
      const desktop =
        host.capabilities.osNotifications === "native" ||
        host.capabilities.keepScreenAwake ||
        host.capabilities.openInApp ||
        !!host.app
      return SETTINGS_SECTIONS.filter((section) => {
        if (section === "desktop") return desktop
        if (section === "devices" || section === "import") return data.local().entry()?.auth !== "device"
        return true
      })
    }
  }

  function accountCommands(runtime: ServerRuntime, sessionID: string | undefined): PaletteCommand[] {
    const state = runtime.own.state
    const current = sessionID ? currentRef(runtime, sessionID) : undefined
    return state.accountOrder.flatMap((accountID) => {
      const account = state.accounts[accountID]
      if (!account || account.status === "retired") return []
      return [
        {
          id: `account.switch:${accountID}`,
          group: "model",
          ...own("own.palette.cmd.switchAccount", { account: account.label }),
          keywords: [...own("own.palette.cmd.switchAccount", { account: account.label }).keywords, account.kind],
          detail: current?.providerID === account.providerID ? text("own.palette.current") : undefined,
          run: () => openSwitcher({ accountID, anchor: composerAnchor() }),
        } satisfies PaletteCommand,
      ]
    })
  }

  /**
   * 문맥 비우기 (03 §18.18): `session.resetContext`, and `session.resetContext.undo` while the active boundary is a
   * reset. Not on a subagent conversation or without `prompt`.
   */
  function resetCommands(runtime: ServerRuntime, sessionID: string): PaletteCommand[] {
    const session = runtime.data.session.get(sessionID)
    if (!session || session.parentID || !runtime.rpc.can("prompt")) return []
    const locale = i18n.locale()
    const words = (key: Parameters<typeof resetText.text>[1]) => resetText.text(locale, key)
    const keywords = [...resetText.text("ko", "own.reset.keywords").split(" "), "/reset-context", "/문맥비우기"]
    const deps = { runtime, sessionID, locale, toast: showToast }
    const active = activeReset(runtime.data.session.message.list(sessionID))
    return [
      {
        id: "session.resetContext",
        group: "sessionOps",
        title: words("own.reset.menu"),
        keywords: [...keywords, resetText.text(locale === "ko" ? "en" : "ko", "own.reset.menu")],
        run: () => resetContext(deps),
      },
      ...(active && !session.revert
        ? [
            {
              id: "session.resetContext.undo",
              group: "sessionOps" as const,
              title: words("own.reset.menuUndo"),
              keywords: [...keywords, "undo", resetText.text(locale === "ko" ? "en" : "ko", "own.reset.menuUndo")],
              run: () => undoReset({ ...deps, resetID: active.id }),
            },
          ]
        : []),
    ]
  }

  /** `/agent <name>` from the palette (also the "reverse cycle" 03 §10 leaves to the palette). */
  function agentCommands(runtime: ServerRuntime, ctx: CommandContext): PaletteCommand[] {
    const directory = ctx.directory
    if (!directory || !ctx.sessionID) return []
    const agents = runtime.data.location.agent.list({ directory })
    if (!agents) return []
    const current = runtime.data.session.get(ctx.sessionID)?.agent
    return agents
      .filter((agent) => agent.mode !== "subagent" && !agent.hidden)
      .map((agent) => ({
        id: `agent:${agent.id}`,
        group: "agent",
        ...own("own.palette.cmd.agent", { agent: agent.name }),
        detail: agent.id === current ? text("own.palette.current") : agent.description,
        run: () => actions.switchAgent(ctx, agent.id),
      }))
  }

  async function startIn(runtime: ServerRuntime, directory: string, projectID: string | undefined) {
    const resolved = projectID ? { projectID, directory } : await resolveProject(runtime.client(), directory)
    setNewSessionTarget({
      serverKey: runtime.key,
      projectID: resolved.projectID,
      directory: resolved.directory,
      name: baseName(resolved.directory),
    })
    router.navigate({ name: "project", serverKey: runtime.key, projectID: resolved.projectID })
    requestAnimationFrame(() => document.getElementById("own-composer-input")?.focus())
  }

  async function copySessionID(sessionID: string) {
    const copied = await navigator.clipboard?.writeText(sessionID).then(
      () => true,
      () => false,
    )
    showToast({
      message: text(copied ? "own.palette.copied" : "own.palette.copyFailed"),
      tone: copied ? undefined : "danger",
    })
  }
}

/** Sessions of every attached server, newest first per server (the index's order). */
export function useSessionCommands(): () => readonly PaletteCommand[] {
  const data = useData()
  const i18n = useI18n()
  const router = useRouter()
  return () => {
    const route = router.route()
    const here = route.name === "session" ? `${route.serverKey}/${route.sessionID}` : undefined
    return data.servers.list().flatMap((entry) => {
      const runtime = data.get(entry.key)
      if (!runtime) return []
      const index = runtime.sessions.state
      return index.order.flatMap((sessionID): PaletteCommand[] => {
        const row = index.sessions[sessionID]
        if (!row || row.archived || `${entry.key}/${sessionID}` === here) return []
        const folder = baseName(row.directory)
        const running = runtime.data.session.status(sessionID) === "running"
        const place = entry.key === LOCAL ? folder : `${entry.label} · ${folder}`
        return [
          {
            id: `session:${entry.key}/${sessionID}`,
            group: "session",
            title: row.title || paletteText(i18n.locale(), "own.palette.untitled"),
            detail: running ? `${paletteText(i18n.locale(), "own.palette.running")} · ${place}` : place,
            keywords: [sessionID, row.directory],
            run: () => router.navigate({ name: "session", serverKey: entry.key, sessionID }),
          },
        ]
      })
    })
  }
}

function isCatalogKey(key: string): key is I18nKey {
  return key in ko
}

/** A pasted session id that the loaded list does not have yet (19.11 "세션 ID 붙여넣기"). */
export function sessionIdCommand(
  query: string,
  locale: Locale,
  navigate: (route: Route) => void,
): PaletteCommand | undefined {
  const id = query.trim()
  if (!/^ses_[0-9A-Za-z]{8,}$/.test(id)) return undefined
  return {
    id: `session.id:${id}`,
    group: "session",
    title: paletteText(locale, "own.palette.cmd.gotoSessionId", { id }),
    keywords: [id],
    run: () => navigate({ name: "session", serverKey: LOCAL, sessionID: id }),
  }
}
