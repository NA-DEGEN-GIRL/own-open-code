# own-web architecture (`@own/web`)

Specs: `own/docs/03-ui-ux.md` (the UI spec: layout, flows, strings, IME, performance rules), `01-architecture.md`
§6 (serving, auth, OwnHost, PF1–PF8), `02-accounts-providers-cache.md` §9 (RPC `own.accounts`), `04-ssh-remote.md`
§12 and §21 (multi-server seams), `05-desktop-and-mobile.md` §6 (OwnHost contract, T0), `09-session-import.md` §3 and
§6 (other tools' conversations, IMPORT). When this file and a spec
disagree, the spec wins; record the difference under "Deviations".

own-web is the renderer of own-desktop and the same build is the web fallback. SolidJS + Vite 8 + Tailwind 4.
It never calls the shell directly (only `OwnHost`), never knows secrets, and asks the service for every decision
(03 P10): accounts, switching, caches, limits and compaction live in `own.accounts`.

## 1. Layout and ownership

The lead owns the skeleton (shared contracts). Module owners own their folder and may add files there; they do not
edit lead files. When a shared contract must change, ask the lead or leave a TODO in the report.

| Path                                                                      | Owner                                    | Contents                                                                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `index.html`, `vite.config.ts`, `vite/`                                   | LEAD                                     | Single inline theme script (CSP hash), build-time CSP meta, dev `/api` proxy with server-side Basic auth                   |
| `src/entry.tsx`, `src/app.tsx`                                            | LEAD                                     | Boot (T0 order) and provider order                                                                                         |
| `src/host/`                                                               | LEAD (desktop host: P4 owner)            | `OwnHost` types, web host, desktop stub, host selection, router mode, window key                                           |
| `src/data/`                                                               | LEAD                                     | Server registry, per-server runtime, event bus, typed RPC, OwnStore, SWR session index, IndexedDB cache, typed server errors (`isLocationMissing`) |
| `src/routing/`                                                            | LEAD                                     | Route table and the two-mode router (path on web, memory on desktop)                                                       |
| `src/shell/`                                                              | LEAD                                     | AppShell grid, tiers, work panel, header, banners, shell shortcuts, theme toggle, minute clock                             |
| `src/keyboard/`                                                           | LEAD                                     | Keymap (03 §10), chord parsing by `event.code`, registry                                                                   |
| `src/ime/`                                                                | LEAD                                     | `createImeEnter` and the rule 6/7 helpers (03 §12)                                                                         |
| `src/i18n/`                                                               | LEAD (catalogs append-only for everyone) | `ko.ts` (03 §14 verbatim + shell), `en.ts` fallback, `t()`, Korean particles                                               |
| `src/perf/`                                                               | LEAD                                     | Marks (03 §20.3) and the input-latency sampler                                                                             |
| `src/styles/`                                                             | LEAD                                     | Tailwind root, own tokens on @opencode/ui v2 tokens, base, shell CSS                                                       |
| `e2e/`, `script/`                                                         | LEAD (specs: each owner adds theirs)     | Playwright (msedge) with the real server, IME harness, bundle-size check                                                   |
| `src/sidebar/`                                                            | SIDEBAR                                  | Sessions tree, rows, "사용 중 계정", folder opening (03 §4.3)                                                              |
| `src/transcript/`                                                         | TRANSCRIPT                               | Virtualized transcript via session-ui, markers, footers, banners, `src/adapter/` (03 §4.5)                                 |
| `src/composer/`                                                           | COMPOSER                                 | IME-first composer, docks, attachments, suggestions (03 §4.6, §12, §18.x)                                                  |
| `src/switcher/`                                                           | SWITCHER                                 | "모델 @ 계정" switcher, cost dialog, running-on pill (03 §5.2, §6)                                                         |
| `src/accounts/`                                                           | ACCOUNTS                                 | /accounts, add account, Claude slot (built in since 2026-10-18), Codex import (03 §5.4)                                   |
| `src/limits/`                                                             | LIMITS                                   | /limits dashboard and the work panel `계정·한도` tab (03 §4.7.1, §5.5, §7)                                                 |
| `src/settings/`                                                           | SETTINGS                                 | /settings/\* pages (03 §5.7, §5.8)                                                                                         |
| `src/requests/`                                                           | REQUESTS (P5)                            | Permission, question/form and web search docks, approval-mode pill/menu/settings, OS notifications (18.1, 18.2, 18.8, 9장) |
| `src/review/`                                                             | REVIEW (P5)                              | 리뷰 tab (modes, base, split/unified, trimmed large diffs in a worker), badge, footer link (18.5)                          |
| `src/terminal/`                                                           | TERMINAL (P5)                            | 터미널 tab and bottom dock (ghostty-web, PTY + ticket socket, reconnect, exit/restart) (18.6, 4.7.3)                       |
| `src/revert/`                                                             | TIMELINE-OPS (P5)                        | `이 지점으로 복원` dialog, 복원 대기 bar, /undo /redo (18.7)                                                               |
| `src/queue/`                                                              | TIMELINE-OPS (P5)                        | `≡ 대기 n` panel: steer/queue rows, reorder, 지금 보내기, 편집, WAIT_SAFE notes (18.9)                                     |
| `src/attachments/`                                                        | TIMELINE-OPS (P5)                        | Chips, ＋/Ctrl+U/paste/drop, uploads to `paths.tmp`, previews, restore into the composer (18.10)                           |
| `src/subagent/`                                                           | TIMELINE-OPS (P5)                        | Breadcrumb of every ancestor, child-session notice, subagent strip, `? n` badges (18.11)                                   |
| `src/mentions/`, `src/commands/`                                          | COMPOSER-EXT (P5)                        | `@` suggestions and chips, `/` catalog, client commands, the composed send path (18.12, 18.13)                             |
| `src/projects/`, `src/mcp/`, `src/policy/`                                | WORKSPACE (P5)                           | Folder picker + Ctrl+O (18.3), MCP list/settings/OAuth exception (18.14), web browser tool rule (18.15)                    |
| `src/browser/`                                                            | DESKTOP (P5, other workflow)             | Native browser pane tab, attachments, tab badge (18.17)                                                                    |
| `src/servers/`                                                            | REMOTE (P6)                              | RemoteStore (`own.remote` adapter), host groups in the sidebar, header badge, session overlay, server tags (04 §12, §17)   |
| `src/remote/`                                                             | REMOTE (P6)                              | Lazy SSH dialogs: add host, prompts, remote folder picker, update/drain/remove/take over, 설정 > SSH 원격 호스트 (04 §17)  |
| `src/vendor/`                                                             | TRANSCRIPT (`timeline/`), INTEGRATOR     | Upstream copies and build-time substitutes, each in `own/ledger/vendored.yaml` (see §7)                                    |
| `src/review/` (comments), `src/git/`                                      | REVIEW-GIT (P7)                          | Diff line comments → chips → next prompt (19.1); Git write actions + confirmation dock (19.2); branch/status chip (19.15)  |
| `src/files/`                                                              | FILES (P7)                               | 파일 tab: tree, file tabs, viewers, Ctrl+P quick open, file links, 에디터에서 열기/탐색기에서 보기 (19.4, 19.5)            |
| `src/worktree/`, `src/background/`                                        | WORKTREE-BG (P7)                         | 작업 위치 selector, move/cleanup dialogs, `⑂` grouping (19.3); background dock, list, output viewer, finish toast (19.7)   |
| `src/history/`, `src/shellmode/`                                          | COMPOSER-PLUS (P7)                       | ↑/↓ history and chip/attachment draft persistence (IndexedDB), `!` shell mode + running chip (19.9)                        |
| `src/skills/`, `src/forking/`                                             | COMPOSER-PLUS (P7)                       | `✦ 스킬` popover (19.6); fork dialog, whole fork, `압축 중…` chip and failure banner, flags cleared on fork (19.12)        |
| `src/notes/`, `src/find/`                                                 | SESSION-UX (P7)                          | Thread notes (UI-only / model-visible entry, 19.10); find in session with a worker index, message navigation (19.13)       |
| `src/notes/workspace*.ts(x)`                                              | NOTES                                    | The workspace `노트` tab's notebook on this PC's service (own.accounts `notes.*`, 05 §8.8); browser-only without a folder |
| `src/ideas/`                                                              | IDEAS                                    | 아이디어 노트 (03 §4.4.1): global sticky notes on this PC's service (own.accounts `ideas.*`); header button, `idea.capture` quick capture (Ctrl+Alt+I) and palette commands in the first chunk, the capture popover and the board lazy |
| `src/voice/`                                                              | VOICE (02 §3.9)                          | Voice input: `DictationButton` (mic, recording bar, insert at the cursor after IME composition, retry) for the composer and both note editors, push to talk `voice.dictate`, the `voice.get` store, the hint, lazy 설정 > 음성 입력 (03 §4.6, §5.7.3) |
| `src/timeline-settings/`                                                  | SESSION-UX (P7)                          | 간단/보통/자세히 timeline presets (19.14); the sidebar's pin/archive/ID search/date groups live in `src/sidebar/` (19.11)  |
| `src/palette/`, `src/settings/shell/`                                     | PALETTE-SHELL (P7)                       | Command palette (Ctrl+K), rebindable keymap + shortcut audit page (19.15, 03 §10); Windows shell setting (19.8)            |
| `dev/`, `e2e/integration/`, `e2e/p5/`                                     | INTEGRATOR                               | Dev service (real server + fakes + seeded data), web-fallback check (P-002), Edge walkthroughs (P3, P5)                    |
| `e2e/p7/`, `src/shell/palette-commands.tsx`, `src/shell/session-menu.tsx` | INTEGRATOR (P7)                          | Edge walkthrough of 03 §19 items 17–32; the feature modules' palette commands; the session header `⋯`                      |
| `src/pairing/`, `src/pwa/`, `src/host/mobile.ts`, `e2e/gateway/`         | REMOTE ACCESS (P8, 05 M1)                | 설정 > 휴대폰·다른 PC (gateway, Tailscale guidance, QR + SAS pairing, devices); the device's pairing screen; mobile host; PWA        |
| `src/computer/`, `src/data/computer-rpc.ts`                              | COMPUTER USE (01 §10.2)                  | ComputerStore (`own.computer`), header chip + 멈추기, session `⋯` switch dialog, 설정 > 컴퓨터 사용 (실험) panel                           |
| `src/remote-pcs/`                                                         | APP ACCESS (08 §4.1, §4.3)               | Sidebar `다른 PC` group, lazy add (link → SAS) / remove dialogs over `host.remotePcs`; 설정 > 휴대폰·다른 PC `모바일 미리보기` (`preview-section.tsx`, loopback link straight to `host.mobilePreview`, never shown) (desktop only) |
| `src/import/`, `src/data/import-rpc.ts`, `e2e/import/`                    | IMPORT (09, 03 §5.9)                     | 다른 도구의 대화: per-server store and entries (first chunk), the list, read-only viewer, `이어서 하기` dialog, origin details and 설정 > 다른 도구의 대화 (lazy); the `own.import` client; the Edge suite |

Every module folder has a typed entry (`index.tsx`, plus `limits/panel-tab.tsx`). Entries marked SKELETON render
just enough to test the shell and data layer; owners replace their internals and keep the exported names/props.

Module exports other modules use (keep names and props stable):

| Module                            | Export                                                                                                                                                  | Used by                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `@/transcript`                    | `Transcript`, `SessionTitle` (title or child breadcrumb), `ChildSessionBreadcrumb`, `ModelAccountChip`                                                  | shell (`app-shell.tsx`, `header.tsx`)                          |
| `@/composer`                      | `Composer`, `ContextMeter`, `followUp` (실행 중 보내기 동작)                                                                                            | shell, settings > 일반                                         |
| `@/switcher`                      | `Switcher`, `RunningOnPill`, `PendingSwitchChip`, `openSwitcher`/`closeSwitcher`, `switcherControl`, `showToast`                                        | shell header, composer, `shell/intents.tsx`                    |
| `@/sidebar`                       | `Sidebar`, `targetFor`/`newSessionTarget` (folder of the next session), `setSidebarDensity`/`sidebarDensity`                                            | shell, switcher, settings > 일반                               |
| `@/limits`                        | default page, `panel-tab.tsx` (계정·한도 tab), `intents.ts` (window-event contract below)                                                               | shell (lazy), accounts                                         |
| `@/requests`                      | `RequestDocks`, `ApprovalModePill`, `RequestNotifications`, `newSessionApproval`; lazy `settings`                                                       | composer, header, shell, settings                              |
| `@/review`                        | `watchReviewTurns`, `reviewBadgeCount`, `ReviewChangesLink`, `openReview`, `reviewMinWidth`; tab = `@/adapter/review`                                   | work panel, transcript, intents, composer                      |
| `@/terminal`                      | `intents.ts` (`requestNewTerminal`, `terminalRunning`); lazy `panel-tab.tsx`, `dock.tsx`                                                                | shell shortcuts, work panel, app shell                         |
| `@/revert`                        | `RevertHost`, `RevertBarSlot`, `revertAction`, `useRevertCommands`, `REVERT_VIEW_CHANGES`                                                               | shell, transcript, composer, intents                           |
| `@/queue`                         | `createQueue`, `QueuePanel`, `useQueueProblems`; `pendingSteerActions` (a pending steer's row actions, 18.9)                                            | composer, transcript                                           |
| `@/attachments`                   | `createAttachments`, `AttachmentChips`, `AttachButton`, `AttachmentDropzone`, `onComposerRestore`, `userPresentation`                                   | composer, transcript                                           |
| `@/subagent`                      | `SubagentBreadcrumb`, `ChildSessionNotice`, `SubagentStrip`, `isChildSession`                                                                           | header, composer, app shell                                    |
| `@/mentions`, `@/commands`        | `createComposerSuggest`, `SuggestPopover`, `MentionChips`; `useCommandActions`                                                                          | composer                                                       |
| `@/projects`, `@/mcp`, `@/policy` | `ProjectOpenerLayer`, `ProjectSelect`, `openProject` (`PickOptions`: a chosen folder to a callback); `@/projects/default-folder`: `defaultFolder`, `isDefaultFolder`, `pickerStart` (a server's 기본 대화 폴더 and 폴더 열기 시작 위치, 03 §5.1, §18.3), lazy `@/projects/folder-settings` (설정 > 일반); `McpLayer`, `ServerStatusPopover`, `McpAuthBanner`; `withBrowserPolicy`, `BrowserToolNotice` | shell, sidebar, composer, switcher, discover, banners, settings, worktree |
| `@/review` (P7)                   | `ReviewCommentChips`, `reviewComments`, `withReviewComments`, `withCommentPresentation`                                                                 | composer, transcript                                           |
| `@/git`                           | `GitStatusChip`, `requestGitAction` (palette → the review tab's confirmation dock); lazy `@/git/actions`, `@/git/state` (review tab)                    | header, palette commands, review tab                           |
| `@/files`                         | `openFile`, `requestQuickOpen`, `FILE_INTENT`, `QUICK_OPEN_INTENT`; tab = `@/adapter/files`; `@/files/actions`, `@/files/editor` by path                | shell intents/shortcuts, transcript, review, browser, settings |
| `@/worktree`                      | `WorktreeSelect`, `resolveNewSessionDirectory`, `worktreeCreating`, `WorktreeHost`, `openWorktreeMove/Remove`, `canMoveSession`, `placeOf`, `workPlace`; `LocationMissingNotice`, `noteLocationError` (03 §8 세션 폴더 없음) | composer, shell, header `⋯`, palette, sidebar                  |
| `@/background`                    | `BackgroundDock`, `BackgroundHost`, `backgroundCount`, `openBackgroundList`, `SendToBackgroundButton` (no transcript slot yet); `RunningMenu` (header 4.4) | composer, shell, sidebar, palette, header                      |
| `@/history`, `@/shellmode`        | `useComposerHistory`, `useDraftPersistence`, `HistoryPosition`; `createShellMode`, `shellRuns`, `ShellRunChip`, `ShellModeHint`, `shellAllowed`         | composer                                                       |
| `@/skills`, `@/forking`           | `SkillsButton`, `openSkills`; `ForkHost`, `useForkMenuItems`, `useForkCommands`, `useCompactNow`, `CompactionStatus`, `openForkDialog`                  | composer, context meter, header `⋯`, palette                   |
| `@/notes`, `@/find`               | `NotesLayer`, `openNotes`; `SessionFind` (transcript chunk), `@/find/priority` (Ctrl+F ahead of session-ui's file find)                                 | shell, header `⋯`, palette, transcript                         |
| `@/voice`                         | `DictationButton` (props `target`, `hint`, `shortcut`, `disabled`), `projectHint`, `buildHint`; lazy `@/voice/settings`                                  | composer, notes panel, workspace notes, settings               |
| `@/ideas`                         | `IdeasLayer`, `IdeasButton`, `openIdeas` (`own:open-ideas`, `capture` or `board`); lazy `./capture`, `./board`                                               | shell (app shell, header)                                      |
| `@/timeline-settings`             | `timelinePreset`; `@/timeline-settings/detail` (`timelineView`, transcript chunk), `@/timeline-settings/setting` (settings chunk)                       | transcript, settings > 일반                                    |
| `@/palette`                       | `PaletteLayer`, `createRebindableRegistry`, `usePaletteCommands`; lazy `@/palette/shortcut-settings`                                                    | app, shell, settings                                           |
| `@/sidebar` (P7)                  | `useSessionFlagActions` (pin/archive through the tree's live flag store), `sessionFlags`                                                                | header `⋯`, palette commands                                   |
| `@/computer`                      | `ComputerLayer`, `ComputerChip`, `useComputerMenu`, `computerStore`, `openComputerDialog`; lazy `@/computer/panel`                                      | shell, header, header `⋯`, settings                            |
| `@/import`                        | `ImportLayer`, `ImportPage`, `ImportHint`, `openImport`, `requestMigrate`, `importStore`, `importGates`, `importEntryCount`, `importSidebarShown`/`setImportSidebarShown`, `refKey`; lazy `list`, `viewer`, `dialog` (also `OriginDetails`), `settings` | app shell, sidebar rows and project menu, palette, header badge, session banners, new-conversation view, settings |
| `@/chat-view`                     | `ChatViewMenu`, `chatView`, `chatViewState`, `setChatMeta`, `toggleChatOnly`, `resetChatView`, `OPT_IN`; lazy `@/chat-view/setting` (03 §4.5 대화 보기, per-viewer localStorage) | header, shell shortcuts, transcript, settings |
| `@/compactions`                   | `CompactionsLayer`, `openCompactions` (`own:open-compactions`); lazy `./dialog` (03 §4.5 압축 내용 보기: every compaction of a conversation from `message.list{type: "compaction"}`, read-only) | app shell, header `⋯`, the compaction marker |
| `@/harness`                      | `HarnessPill` (에이전트 방식 pill and menu), `newSessionHarness` (one-time pick + the service default from `list`), `requestHarnessMenu`, `switchHarness`; `@/harness/default-setting` (Settings > 일반, own.harness `defaults.set`) | header, composer, header `⋯`, settings |

Cross-module requests without a shared import go out as window events (`src/limits/intents.ts`, detail typed there)
and the shell resolves them in `src/shell/intents.tsx`: `own:open-switcher` (opens the switcher for that session,
navigating there first) and `own:new-session` (that account becomes the next new session's combination, then the
new-session screen with the composer focused). `own:open-session-info` waits for the session-info drawer (03 §5.6).
P5 adds `own:open-review` (review/intents.ts: navigate, then the 리뷰 tab), `own:revert-view-changes` (the restore
bar's `변경 보기` → the review tab's `reverted` mode), `own:composer-restore` (revert and queue `편집` put a message
back; the composer sets the text, the attachment store its chips) and `own:composer-add-mention` (a chip for the
session on screen, Ctrl+Shift+L from a tab). P7 adds `own:open-file` and `own:quick-open` (files/intents.ts: navigate,
then the 파일 tab; the request waits until the lazy tab takes it) and `own:open-notes` (notes/intents.ts, resolved by
`NotesLayer`). UC adds `own:open-compactions` (compactions/intents.ts, resolved by `CompactionsLayer`). The feature modules keep their strings in their own `strings.ts`
(`own.<area>.*`, ko + en, same `t()` rules) like the sidebar; shared keys of 03 §14 stay in `src/i18n`.

Lazy chunks (03 §20.2 R5): `accounts`, `limits`, `settings` pages, the `계정·한도` tab (`limits/panel-tab.tsx`),
placeholder tabs, and the desktop host. P5: the 리뷰 tab (`adapter/review.tsx` → session-ui review + pierre diff, its
worker), the 터미널 tab and dock (ghostty-web a further chunk), the request docks and the approval menu, 설정 >
승인·권한 and MCP, the revert dialog and bar, the attachment preview, the `@`/`/` engine (prefetched when idle), the
folder picker, the MCP dialog/server panel, and the browser pane (desktop). P7: the 파일 tab (`adapter/files.tsx` →
`files/panel`; pierre and the markdown pipeline are further chunks), the Git actions (inside the review chunk), the
worktree picker and dialogs, the background list and output viewer, the skills popover, the fork dialog, the notes
dialog, the palette dialog (prefetched when idle), 설정 > 단축키 and 셸·터미널, and the find bar with its worker (transcript
chunk). Computer use: the per-session dialog (with the switch logic) and 설정 > 컴퓨터 사용 share `computer/panel-strings.ts`;
only the store, the header chip and the `⋯` item are in the first chunk (+2.2 KB gzip, 244.4 → 246.6 KB). 다른 도구의 대화
(IMPORT, 09): the list, the viewer, the `이어서 하기` dialog with the header badge's origin details, 설정 > 다른 도구의 대화 and
their words (`import/strings.ts`) are lazy chunks; the first chunk has `import/index.tsx`, `import/store.ts` and the
labels of the entries (sidebar row, project menu item, palette command, settings section, page title, header badge,
first-screen line, entry 4) in `i18n` (`own.otherTools.*`). Initial JS after IMPORT wave 5: 319.0 KB gzip (budget
400 KB, `bun run size`). Sidebar, transcript shell,
composer and switcher pill are in the first chunk. A new tab/dialog/page must be a
lazy import (review checklist, 03 §20.4).

### Rules that everyone follows (enforced by `src/boundaries.test.ts` where possible)

- `@opencode/client` runtime imports only in `src/data/`; types anywhere. The `own.accounts` id and `rpc.call` only in
  `src/data/` (03 §16.3). Screens use `useData()` → `own` (OwnStore) and `own.rpc.call(method, input)`. The
  `own.import` id (RPC id, event prefix and session metadata key) is also known only by `src/data/`; screens read that
  metadata through `IMPORT_META`, `isImportHelper` and `importOrigin`.
- `@opencode/session-ui` only through `src/adapter/` (created by the transcript owner, 03 §16.1).
- `@opencode/desktop` only in `src/host/desktop.ts`, loaded by dynamic import (05 §6.6).
- Never compare `host.kind` outside `src/host/`; gate on `host.capabilities.*` (03 §16.7).
- Forbidden calls: credential activate, integration connect (only `src/mcp/oauth.ts` may, 03 §16.3), location
  reload, `/api/pair`, `?auth_token=`, writing `permissions` with `session.update` (use `session.approval.set`).
- No hardcoded user-visible strings: add keys to `src/i18n/ko.ts` (and English to `en.ts`) at the end, in a section
  named after your module, `own.<area>.*` namespace, placeholders `{name}`.
- Secrets never enter UI state, logs, URLs, IndexedDB or localStorage (SSH tokens: tab memory only, 04 §12.1).

## 2. Startup (T0, 05 §6.3) and data flow

```
entry.tsx ── createHost() ── web host (static) | desktop host (dynamic import, throws until P4)
   └─ render <App>
        Host → Theme(@opencode/ui ThemeProvider) → I18n → Data → Router → Shortcuts → Shell
        ThemeProvider.onThemeApplied → host.setChrome()        (T0-4, every theme change)
                                     → rAF → host.ready()       (T0-3, once) + mark own:first-paint

createDataLayer(host)
   ├─ runtime("local") created at once: EventBus + SessionIndex (reads IndexedDB → rows → own:sessions-visible)
   │                                    + createData + OwnRpc + OwnStore   (no network yet)
   └─ host.connect() → HostConnection{baseUrl, auth, controlDir?} → registry.upsert(local) → runtime.attach()
                        attach = OpenCode.make({baseUrl}) + createClientConnection (one /api/event stream)

/api/event ──► createClientConnection (flushInterval 16) ──► EventBus.publish ──► one Solid batch per frame (rAF,
                                                                                   50 ms fallback when hidden)
   ├─ createData (session-ui data: messages, parts, permissions, forms, inbox)
   ├─ SessionIndex: server.connected → GET /api/project + /api/session?parentID=null&limit=50 (replace, persist
   │                when idle) ; session.created/renamed/model.selected/moved/status/deleted → incremental
   └─ OwnStore: server.connected → resync (health, accounts.list, quota.snapshot, visible bindings, open sessions'
                cache.state + switch.state) ; rpc.own.accounts.* → dedupe by eventId → apply
                quota.updated / cache.state / ledger.step coalesced 250 ms (last per key) ; compaction.due executed
```

- Server registry (04 §21 seam 1): `(serverKey, sessionID)` everywhere; `local` today, SSH hosts later through
  `data.ensure(hostId, "ssh")` + `attach(entry)` with `entry.headers` (resolve token, memory only). `baseUrl` may
  carry a path prefix (gateway `/srv/<serverKey>`); the generated client preserves it.
- `attach()` again replaces client and stream (SSH epoch change, desktop service restart) without touching stores,
  routes or the composer.
- Reconnect: `createClientConnection` loops (1 s delay, 45 s watchdog); `server.connected` triggers every resync.
  `data.hostError()` is set when `host.connect()` fails; the cached list stays visible.

### own.computer RPC (`src/data/computer-rpc.ts`)

- Typed from `@own/protocol/rpc-computer` (types only); `COMPUTER_SCOPE` is the client copy of `OwnComputer.MethodScope`
  (compared in `computer.test.ts`). Every method is called at the local control location: the plugin keeps one
  desktop per process, so any Location answers. A gateway device gets no scope here yet: the gateway passes `status`
  and `killswitch.engage` to a device with `prompt` or `switch` (own-remote `Policy.COMPUTER_METHODS`, 05 §13.4), but
  the phone UI does not call them (follow-up).
- `computerEvent` parses `rpc.own.computer.status|action`. Every Location's plugin instance republishes the same
  notice, so the ComputerStore (`src/computer/state.ts`) replaces `status` and keys `action` by (session, tool, time).
- The store asks `status` only when something needs it (the session `⋯` opens, a session whose rules turn computer use
  on is shown, 설정 > 컴퓨터 사용 or 플러그인), then again on each local `server.connected`, and follows events; `action` events
  mark a session active for 8 s (header chip), with no polling. Nothing is asked at startup: a service without the
  plugin answers 400 (`rpc.unavailable`), a failed resource in the console that `check:fallback` and the e2e
  error watchers would see in every window. `HostMenu` gained `onOpen` for the `⋯` case.
- The per-session switch is own.accounts `session.approval.set{sessionID, mode:<current mode>, computerUse}` through
  the local runtime's OwnRpc (`src/computer/switch.ts`); its state is read from the session's rules (`computerUseOf`,
  the plugin gate's rule), so `session.permissions` updates the header without a request.

### own.accounts RPC (`src/data/rpc.ts`)

- Types come from `OwnAccounts.Definition` (`OwnInput<M>`, `OwnOutput<M>`, `OwnEvent<E>` discriminated by name).
- Location per `OwnAccounts.MethodLocation`: `control` → control directory; `session` → the session's directory
  (from createData or the session index); `session.binding` and fallbacks pass `options.directory`.
- Control directory (02 §9.1, Q41): `HostConnection.controlDir` (desktop: `window.own.shell.controlDir`; web
  fallback: launcher fragment `#control=…`, remembered in sessionStorage; dev: `OWN_WEB_CONTROL_DIR`); otherwise
  `health` on an already known project directory (never an arbitrary directory).
- Scopes per `OwnAccounts.MethodScope`. PC windows (`auth` injected/cookie) hold every scope; a gateway device holds
  what the gateway granted and never `local`. `own.rpc.allowed(method)` hides buttons; `call` rejects with
  `OwnRpcError{type:"own.scope_denied"}` before sending. `own.rpc.can("prompt")` gates HTTP-side actions
  (`compaction.due`, `clientAction`).
- Errors: `OwnRpcError{type, message, data}` with the server's declared type (02 §9.4), `rpc.*` system types,
  or client-side `own.scope_denied | own.location_unknown | own.control_unknown`.
- `OwnStore.state.status`: `unmanaged` when `health.guard` ≠ ok or the RPC is missing (`rpc.unavailable`,
  `rpc.method_not_found`) → banner with `own restart`; `unavailable` for other failures.

### OwnStore (`src/data/own-store.ts`)

Normalized by id: `accounts` + `accountOrder` + `accountByProvider`, `quota[accountID]`, `binding[sessionID]`,
`cache[sessionID]`, `switchState[sessionID]`, `compactionRequested[sessionID]`, `alerts` (50). Components read the
slice they need. `watchVisible(ids)` (chips) and `watchOpen(id)` (header/panel of an open session) are
reference-counted and reloaded on every resync. `own.on(name, fn)` delivers de-duplicated raw events (transcript
markers use `switch.recorded`, notifications use `alert`, `switch.suggested`, …).

- **Presets (07, `presetGroups`, `presetSettings`).** This PC's store reads `presets.list` on resync and follows
  `presets.changed`. **An SSH host's store (T3, 07 §8.1 원격)** reads that host's `presets.list` (its mirror of this
  PC's presets) only after a screen calls `refreshPresets()` (the remote composer mounts, a preset menu opens) and then
  on every resync: a remote service never sends `presets.changed`, and `data/data.test.ts` keeps a host's resync at
  `health` alone until something asks. New-session defaults still come from this PC's store.

### Team mode and presets screens (06, 07; lazy chunks)

- **Data.** `src/data/team-rpc.ts` (typed `own.team` client, a copy of `OwnTeamRouting` scopes and locations, event
  parsing) hangs on `ServerRuntime.team` for every server, SSH hosts included (a host's team answers at its control
  location). `src/data/remote-rpc.ts`'s `REMOTE_SCOPE` copy has `hosts.tools.ensure` (`manage`, T3).
- **`src/team/`** (06 §9): `store.ts` (TeamStore per server: `team.get`, events, notices, retire candidates),
  `model.ts`/`view-model.ts` (words, rows, area actions and proposal builders), `strings.ts` (ko/en, the forbidden-word
  test of 06 §9.1 in `strings.test.ts`), `enable.ts`, `summary.tsx` (result cards), `confirm.tsx` (confirm dialogs),
  `area-menu.tsx`, `integrate.tsx`/`integrate-model.ts`, `decide.tsx`, `intents.ts`, and since T3 `reorg.tsx`.
- **T3 (06 §8, §9.4, §9.7).**
  - Area menu (`areaActions`): 나누기…, 영역 묶기…, 파일 모양 바꾸기, 대화 옮기기…, 영역 끝내기…, each shown only with its
    `reorg.*` feature in `health.features` and the `reorg.apply` scope; 영역 묶기 needs another active area, 파일 모양
    바꾸기 a `code` or `full` area; a stopped or finished area keeps 영역 끝내기. Each item is a panel in `team/reorg.tsx`
    that ends in `reorg.apply{teamID, proposal}` (by `user`); the proposals come from `view-model.ts`
    (`splitProposal`, `mergeProposal`, `retireProposal`, `recreateProposal`, `convertProposal`, `moveProposal`,
    `moveCandidates`, sharing `newAreaProposal`'s slug rule).
  - 팀 구성 다시 보기 (project menu, lazy `reorg.tsx`; shown when any of `reorg.split/merge/retire/convert` is listed and
    `reorg.propose` is allowed): `reorg.propose` → the proposal card (one line per op and area, `· 확인한 뒤 합니다`,
    rejections with their reason, suggestions with `[끝내기…] [무시]`, notes) → `reorg.apply{proposalID}` at once
    when the plan has steps.
  - Retire signal: `TeamStore.retireCandidates`/`ignoreRetire` (in memory per window, keyed by `retirable.since`, so
    `[무시]` does not survive a reload and a later quiet period suggests again); the suggestion cards sit on top of the
    team result cards, and `shell/notifications.tsx` mounts that slot when candidates exist; `areaRow` gives
    `끝낼 수 있음`, and `[다시 만들기] [끝내기]` for a `missing` area (06 §8.8).
  - 다시 만들기 (06 §8.2, §8.8, approved 2026-10-05): `recreateProposal` is a new area from an area's record
    (`ops:[{op:"new", slug, name, goal, from: slug}]`; the service names it `<slug>-2` and starts at the old branch's
    tip). A `missing` area offers it on its row (`[다시 만들기]`, with `reorg.new` and `reorg.apply`) and in its menu
    (`다시 만들기…`, before 영역 끝내기); both open the area menu's `RecreatePanel` (`AreaTarget.panel: "recreate"`).
    A join's result card offers 'B 다시 만들기' when its 되돌리기 answers `conflict` (A moved on; `undoConflict`, the
    undo button goes) and when an undo op left B out because its folder was gone (`merge-undo-area` done, B still
    retired; `joinedAreas`).
  - Confirms (`confirm.tsx`): the removal list largest first with sizes and total, bundled removals (the title counts
    removals only), focus on `두기`, a re-read when the list (`manifest`) changed; `남는 것` shows
    `반영하지 않은 저장 지점 n개…` from the step's `args.unapplied` (own-team does not send it yet); system-change
    confirms (`protect-shared`, `integrate-assets`, `isSystem`) add `바뀌는 설정`/`되돌리는 법` (ACL on this PC, chmod when
    the service's `health.mode` is `remote`), the command only under `자세히`. Result and integration cards open them
    with `확인하기…` (`반영하기` only for an apply confirm); the integration card also shows the `integrate-assets`
    confirm of a later op of a running integration for the same area. An integration that runs in several ops (the
    first `.assets` confirm, an upload) shows one card above the team main, the card of its newest op
    (`team/summary.tsx`); `두기` on the first `.assets` folder reads `own.team.integrate.failed.assetsDeclined`, not
    the failed check. 끝난 영역 정리하고 끄기 toasts `own.team.disable.waiting` (the team goes off once the removals are
    answered). The 팀 구성 다시 보기 card names areas as they were when the main proposed, even after a rename ran.
  - Remote teams (`team/lfs.ts` `withLfs`, used by enable, 새 영역, 나누기 and 팀 구성 다시 보기): on `lfs_missing`,
    when this window may call this PC's own.remote `hosts.tools.ensure` and the server is an SSH host (`hostId` =
    server key), exactly one upload and one more call; a failed upload is `LfsUploadFailed` and shows
    `own.team.enable.lfsFailed` with own.remote's reason. Never loops.
  - Confirms (`team/confirm.tsx`): an ended op's confirm is never shown again; a bundle whose step failed answers the
    rest and toasts `own.team.confirm.stepFailed`; a removal list flags files that cannot be made again
    (`own.team.confirm.irreplaceable`).
  - `worktree/remove.tsx`: an own-locked folder that is an area (retired ones included) offers `영역 끝내기…`, which
    closes the dialog and opens that area's menu at the retire panel (`AreaTarget.panel: "retire"`, `intents.ts`).
  - Strings: the T3 key groups are listed in 03 §14. Every service step kind has an `own.team.step.kind.*` label
    (`strings.test.ts`).
- **Presets (07; `src/presets/`, `src/composer/preset-button.tsx`, `binding-button.tsx`).** The composer's preset
  button, the editor and 설정 > 프리셋. **Remote sessions (T3, 07 §8.1 원격)**: `presetPlace(remote, local)` in
  `presets/model.ts` answers `local` (this PC), `mirror` (the host lists this PC's presets; also when neither side has
  saved presets) or `builtin` (the host lists none of this PC's saved presets: an older build or before its first
  mirror; also until the host's list loaded). A `mirror` session lists the host's presets (its ★ first) and applies
  through that host's `session.preset.apply`, or its own.team `area.preset` in an owner conversation (`applyPreset`,
  `applyStartPreset`); `새 프리셋…`/`편집…` open this PC's editor, and every `presets.*` write goes through
  `data.local()` (a source test checks it), so nothing writes presets on a host. Repair dots, repair lines and marks
  are for `local` only. A `builtin` host shows `평소대로` with `own.subagent.preset.remoteBuiltin`. `menuParts()`
  decides the builtin-only rows, repairs, editing and the note; `PresetMenu` takes `server` (the old `remote` prop is
  gone). Remote team area menus (`team/area-menu.tsx` `PresetPanel`) and remote team main rows
  (`sidebar/controller.ts`) use the same place, and so do `switcher/team-flow.ts` `presetLineFor` (the switcher's
  `프리셋:` line) and `subagent/rejected.tsx` `하위 에이전트에 추가…` (T3.19; `평소대로` only when the host has none).
  **Model pool (T4, `모델 묶음에서 알아서`).** Every mode read goes through `Preset.modeOf` (the editor's
  `draftMode` adds the pool chosen before a model is checked; a test greps for direct reads). A pool is stored as
  `mode: "same"` plus `workers.pool`; leaving the choice drops the pool and the editor keeps the list while open.
  `presets/pool-list.tsx` (the checklist, lazy with the editor) shows `presets.suggest` `pool.candidates`; its logic is
  `presets/model.ts` (`poolSections`, `withPoolEntry`, `withPoolAccount`, `withRecommended`, `poolFacts`); the
  previews call `Preset.poolGuidance`/`renderGuidance` over the session's `Resolution.pool` facts (passed as
  `EditorRequest.pool` by the chip and the composer menu) or the candidates'. `자세히` edits each entry's effort and
  note and refreshes cards (`presets.set{refreshCards}` of the stored preset); `focusRole` may be `pool:<key>`. The
  refusal chip of a pool (`Allowed models:`) offers `묶음에 추가…` (`presets/chips.ts` `poolAddition`), and a gone
  pool model's repair replaces the entry under a new key without its card (`presets/repair-notice.tsx` `repooled`).
- PF5: the team and preset screens stay in lazy chunks (`reorg-*.js`, `strings-*.js`, `confirm-*.js`); initial JS
  301.9 KB gzip after T3's UI (budget 400 KB).

### 다른 도구의 대화 (09, IMPORT; `src/import/`, lazy chunks)

- **Data.** `src/data/import-rpc.ts` (`createImportRpc`, made by `createServerRuntime` next to the TeamStore:
  `runtime.imports` on every `ServerRuntime`, one exported type): types only from `@own/protocol/rpc-import`, the id,
  scope table, `scopeOf` and event list from `rpc-import-routing` (plain tables, the same the gateway decides with),
  every method at the server's control location; `call`/`allowed`/`scope`, where `allowed(method, input?)` and `call`
  gate by the input's scope (`scope: "all"` and `redact: false` are `local`, 09 §5.5); `importEvent`
  parses `rpc.own.import.index.changed|job.progress|job.finished` (unknown names ignored); `IMPORT_META`,
  `isImportHelper`, `importOrigin` read the session metadata. An SSH host has no own.import (`health` fails, the store
  keeps `null`).
- **Store and gating** (`import/store.ts`, first chunk). Nothing is asked at startup (R8): an open project row, entry 4,
  the project menu or the palette ask `health` once after the list paint (`own:sessions-visible`) and when idle, and
  `sessions.list{limit: 0}.fresh` per shown project; `index.changed` re-counts the folders it names and a succeeded
  `job.finished` every shown project (the imported conversation is no longer new). `importGates`
  decides each surface from `health.features` (`view`, `search`, `migrate`) and the scope table: a gateway device sees
  the list, viewer and search with `read` and `이어서 하기` with `prompt` (Q2, 09 §5.5); 설정 > 다른 도구의 대화 needs
  `sources.configure` (`local`) and is hidden on device connections (`settings/index.tsx`, and the list's `찾는 곳 설정`
  link); `allFolders` (`sessions.list{scope: "all"}`, `local`) shows the `이 폴더 / 모든 폴더` filter on this PC's windows
  only. The viewer and the dialog name the project's folder in every read and plan, with `scope: "all"` only where the
  connection may ask it, and a device cannot turn `비밀 가리기` off. `사이드바에 보이기` is a per-viewer setting
  (localStorage).
- **Routes** (`routing/routes.ts`): `import {serverKey, projectID, ref?}` = `/srv/<serverKey>/p/<projectID>/import`
  and `…/import/<kind>/<rootID>/<id>` for the viewer; settings section `import` (`/settings/import`). `ImportPage`
  (rendered by `shell/app-shell.tsx` over the mounted session view) loads `list.tsx` or `viewer.tsx`; `ImportLayer`
  (mounted once) takes the open requests and shows the lazy `dialog.tsx`.
- **Entries** (09 §6): the sidebar row `다른 도구의 대화 · 새 N개` at the end of an expanded project
  (`sidebar/rows.tsx`, hidden at 0, when the setting is off or own.import is not usable here), `다른 도구의 대화…` in the
  project `⋯` for every project, Git or not (`sidebar/project-menu.tsx`; team items stay Git-only), the palette command
  `다른 도구의 대화 열기` (`shell/palette-commands.tsx`) and entry 4, the hint on a folder's empty new conversation
  (`transcript/session.tsx` → `ImportHint`, dismissed per viewer).
- **Screens.** The list (`list.tsx`: filters, title search and `내용까지` with `계속 찾기`, virtual rows, tags with the Q3
  rule of `model.ts` `expiry`: Claude Code's default 30 days, a tag from 7 days left, the tooltip before), the
  read-only viewer (`viewer.tsx`: the production timeline through `adapter/session-ui`, pages of 20 turns, markers,
  the streaming outline, Ctrl+F over `sessions.search{ref}`, `원본 위치 열기` on the desktop's local connection through
  `host.files.openPath`, `텍스트로 복사`, a footer status line), the `이어서 하기` dialog (`dialog.tsx`: default target
  rules (the source tool's subscription slots only: `codex`/`siwc`, `claude-sub`), mode rows with costs, the send
  notice, location, `자세히`, the 300 ms re-plan, the job followed per server
  outside the dialog with toasts and restore from `jobs.list`; `model.ts` `createPlanner` hands over only the newest
  plan and marks one that answers inputs the user changed since as stale, so its nonce never runs with an old target
  or mode) and 설정 > 다른 도구의 대화 (`settings.tsx`). Words in
  `import/strings.ts` (lazy), first-chunk labels in `i18n` (`own.otherTools.*`).
- **Imported sessions and helpers.** `shell/header.tsx` shows `<Codex|Claude Code>에서 가져옴` for `own.import` import
  metadata (the lazy `OriginDetails` on press); `shell/session-banners.tsx` the first-screen line. An imported
  conversation arrives whole in its `session.created` commit, so `data/server.ts` drops createData's empty transcript
  for it and its first view reads the messages. Hidden helper
  sessions (`own.import.helper`) never become rows: `data/session-index.ts` drops them (also those named by
  `job.progress{helperSessionID}` after a reload), and `sidebar/flags.ts`, `sidebar/search.tsx`, `sidebar/controller.ts`
  and `shell/notifications.tsx` skip them.
- **Toasts** are mounted by `shell/app-shell.tsx` outside the session section (IMPORT wave 5), so pages such as the
  import list show them.
- Tests: `src/import/import.test.ts` and `dialog.test.ts` (a fake client: fresh counting and hiding, filters, tags and
  the Q3 rule, outline streaming, scope gating, default target, mode rows, debounce, job restore, the helper filter),
  `src/data/data.test.ts`, `src/boundaries.test.ts`, `src/routing/routes.test.ts`; the Edge suite
  `bun run test:e2e:import` (§8).

## 3. Host (`src/host/`)

`OwnHost` follows 03 §16.7 (names of the capability table): `kind`, `capabilities`, `connect()/reconnect()`
→ `HostConnection{baseUrl, auth: "injected"|"cookie"|"device", controlDir?, scopes?}`, `ready()`, `setChrome()`,
`openExternal()`, optional `files`, `browser`, `service`, `window{focus, show, isFocused, zoom?}`, `notify`.

- Web host: `baseUrl = location.origin`; `auth` is `injected` under the Vite dev proxy and `cookie` in the web
  fallback; capabilities off except `osNotifications:"web"` and detected `touch`.
- Desktop host: stub that throws `HostUnavailableError` (P4). It is only reachable by dynamic import, so the web
  first chunk has no desktop code (checked by `bun run size`).
- `routerMode(host)`: memory router on desktop (no SPA fallback on `oc://renderer`, state per `windowKey`), path
  router elsewhere. Route names are identical.
- Mobile host (05 §13.9 M1, `src/host/mobile.ts`, its own chunk): chosen when the page carries
  `<meta name="own-gateway">` (the own-remote gateway adds it; never on the PC's origins). `connect()` →
  `{baseUrl: <origin>/srv/local, auth: "device", controlDir, scopes}` from `GET /own/device`; a 401 (never paired,
  revoked, expired) or the `/pair` path throws `DeviceAuthRequiredError` and the entry shows the pairing screen
  (`src/pairing/device-screen.tsx`) instead of the app; offline, the remembered non-secret device info
  (`own.web.device` in localStorage) lets the cached list paint. `reconnect()` asks again and reloads into the pairing
  screen on a 401 (MG4). SSH hosts on a device come from `GET /own/servers` (`/srv/<hostId>`, no token in the tab:
  RemoteStore's device branch).

## 4. Shell (`src/shell/`)

- Grid `sidebar | main | panel`; tiers by viewport width (03 §4.2): wide ≥1440 (272/420 push, panel open by
  default), desk 1280–1439 (256/380 push), compact 1100–1279 (240, panel overlay drawer), tablet 600–1099 (sidebar
  drawer, panel sheet), phone <600 (list screen on `/`, full-screen panel). Tiers only change attributes and CSS:
  the composer and transcript are never re-created (IME rule 5); tested in e2e.
- Closed surfaces are `inert` (panel, drawers, collapsed sidebar, phone's hidden column). Esc and the scrim close
  overlays; navigation closes them on narrow tiers.
- Widths: `@opencode/ui/resize-handle`, only CSS variables change while dragging (R7); saved per window in
  localStorage (`own.web.layout.<windowKey>`), defaults when storage fails. Last panel tab is remembered per session.
- Work panel tabs 리뷰/파일/터미널/브라우저/계정·한도: `브라우저` only with `capabilities.browserPane`, `터미널` only when
  placed as a tab. Content is lazy on first open (`own:panel-open:<tab>` mark), stays mounted while hidden, and gets
  `visible()` to stop rAF/observers. Tab owners replace their loader in `shell/work-panel.tsx` `LOADERS` (파일 is the
  last placeholder, replaced in P7 by `@/adapter/files`). Badges: 리뷰 = files the last turn changed until the tab showed the session, 터미널 =
  running PTYs, 브라우저 = the desktop module's. The review tab's split view raises the pushed panel's minimum to 560 px.
- 터미널 위치 `대화 아래` (4.7.3): the dock is mounted after the composer on first show and kept (hidden = `inert`);
  `shell.openTerminal()` opens the tab or the dock, Ctrl+` toggles the dock in that placement.
- Mounted once by the shell: `RequestNotifications`, `RevertHost`, `ProjectOpenerLayer` (Ctrl+O), `McpLayer` (Ctrl+;),
  `ComputerLayer` (01 §10.2: the ComputerStore and the per-session dialog).
  Between the transcript and the composer: `RevertBarSlot` and `SubagentStrip`. Session banners add "MCP 인증 필요"
  and the browser tool note. The header adds the approval pill (session, home and project routes) and the full
  subagent breadcrumb.
- Composer (P5): dock stack `RequestDocks` → `QueuePanel` above the box; the `@`/`/` controller gets the textarea's
  keys first; attachment chips, `＋`, paste and drop (the session column); `own:composer-restore`; child sessions keep
  the (read-only) textarea and show `ChildSessionNotice`; the new-session screen shows `ProjectSelect` and the
  browser tool note; `create()` applies `withBrowserPolicy` and writes `newSessionApproval` before the first prompt.
- P7 shell: also mounted once `ForkHost`, `BackgroundHost`, `WorktreeHost`, `NotesLayer`, `PaletteLayer` (Ctrl+K) and
  `PaletteFeatureCommands` (git commit/push/PR, worktree new/move/cleanup, notes, pin/archive, background list,
  skills, fork from a message). The header adds `GitStatusChip` after the title and the session `⋯`
  (`session-menu.tsx`: 포크, 이 메시지에서 포크…, 지금 압축, 내보내기, 노트, 고정, 보관, 에이전트 방식 바꾸기…, 다른 작업 폴더로 옮기기…). App uses
  `createRebindableRegistry()` so rebinding in 설정 > 단축키 applies without a reload.
- P7 composer: dock stack `RequestDocks` → `QueuePanel` → `BackgroundDock`; in the box `ShellRunChip`,
  `CompactionStatus`, `ReviewCommentChips` above the attachment and mention chips; toolbar `SkillsButton`, and on the
  new-session screen `WorktreeSelect` after `ProjectSelect`; under the box `HistoryPosition` and `ShellModeHint`.
  Textarea keys: suggestions → IME machine → ↑/↓ history → shell mode (Esc/Backspace); `!` is consumed on input.
  Sends record the history entry (chips kept) before chips are taken; review comments go with the prompt
  (`withReviewComments`) and come back on failure; `!` commands run through `shellRuns` (`session.shell`); a new
  session resolves its folder with `resolveNewSessionDirectory` first (send locked while a worktree is created).
  `/fork`, `/compact`, the palette's compact/fork and the context meter's `지금 압축` all go through the forking module.
- P7 transcript: the timeline preset (`timelineView(timelinePreset())`) feeds the projection, renderer and the
  virtualizer's `presentationKey`; user messages get `withCommentPresentation`; markdown local links call `openFile`;
  `SessionFind` sits in `.own-transcript-body` and seeks turns itself (the `revealMessage`/`unpin` handover broke far
  jumps in e2e/session-ux, so it is not used).
- Pages (`/accounts`, `/accounts/add`, `/limits`, `/settings/:section`) render over a mounted session view.
- `shell/clock.ts` is the only periodic UI timer (1 min, paused while hidden; R9/PF8). Use it for relative times
  and reset countdowns.

## 5. Keyboard (`src/keyboard/`)

- `DEFAULT_KEYMAP` holds every 03 §10 shortcut by id (`Mod` = Ctrl, ⌘ on macOS), including the upstream-conflict
  decisions. `findConflicts` must stay empty (unit test).
- One window keydown listener; nothing fires while composing (`isComposing` or keyCode 229). Chords use
  `event.code`; `key` is a fallback only for synthetic events without `code` ("Process" ignored).
- Contexts come from the nearest `data-own-keys` attribute: `composer` (composer-scope ids live, `notInComposer`
  ids off — Ctrl+B), `terminal`/`browser` (only palette, panel toggle and tab switches).
- Register with `useShortcut(id, handler, {when})` in the component that owns the action; returning `false` lets
  the event through. Capability-gated ids (browser tab, zoom) are simply not registered.
- P5 registrations: `approval.menu` (approval pill; opens the menu only), `dock.focus` (request docks, only while one
  is up), `folder.open` (ProjectOpenerLayer), `mcp.list` (McpLayer), `terminal.new` (shell before the terminal chunk,
  the terminal panel once mounted), `panel.terminal` (tab or dock by placement), `composer.attach`,
  `composer.queueEditFirst` (queue). The 03 §10 conflict decisions are in `DEFAULT_KEYMAP` (Ctrl+B sidebar outside
  the composer, `Alt+B` background; Ctrl+. switcher, Ctrl+Shift+. agent cycle; Ctrl+Shift+L `context.addSelection`,
  the panel is Ctrl+Alt+B and 계정·한도 Ctrl+Shift+U) and checked in the P5 walkthrough.
- P7 registrations: `palette.open` (PaletteLayer), `file.open` (shell → `requestQuickOpen`), `session.find`,
  `message.previous/next` (SessionFind, while its transcript is active), `context.addSelection` (review tab, also in
  the capture phase inside the comment editor), `composer.shellMode/shellExit` (shell mode), `composer.background`
  (BackgroundDock, only while a shell/subagent runs). Rebinding: `palette/rebindable.ts` wraps the registry and
  re-registers everything on a keymap change (user keymap in localStorage `own.web.keymap.v1`); the audit page shows 0
  conflicts under both Windows and macOS rules (unit-tested). Ctrl+F: session-ui's `File` installs a page-wide
  capture listener for Ctrl+F on first mount; `find/priority.ts` (installed by the shell at startup, so it runs first)
  gives the key to the transcript's find outside file viewers (`[data-own-file-find]`: files code view, review diff).

## 6. IME (`src/ime/`, 03 §12)

`createImeEnter({onEnter, commitOnly?})` for every text input: own composition flag, keyCode 229 defense,
Enter during composition sends once after the commit (no time windows: `sent` clears on the next input or
compositionstart), other keys are ignored during composition, `commitOnly` (switcher/palette search) commits on the
first Enter and applies on the next (the A1 duplicate keydown is recognized by the missing keyup).
`commitComposition(el)` flushes a composition before a button/shortcut send (rule 6, ≤300 ms); `clearNextFrame(el)`
clears after sending (rule 7). Never replace or re-render the input element while composing.
Tests: unit (orders A1, A2, B, commitOnly) and Edge e2e (`e2e/ime.spec.ts`: dispatched orders + a real Chromium
composition through CDP `Input.imeSetComposition`, which produced compositionstart → keydown(229, composing) →
compositionend, i.e. A2).

## 7. i18n, theme, styles

- `t(key, params)`: current locale → Korean fallback; `{name}` params; `(으)로 (이)가 (을)를 (은)는 (와)과 (이)라`
  resolved from the final sound of the text before them (Hangul, digits, English heuristics).
- Theme: `@opencode/ui` ThemeProvider (theme ids, `data-color-scheme`), the inline preload uses the same storage
  keys. Dark is the default: `src/shell/theme-default.ts` stores `dark` when no scheme is stored before the provider
  starts (App), and the preload paints dark unless `light`/`system` is stored. `--own-*` tokens map onto `--v2-*`
  with the 03 §13.2 values as fallbacks; Tailwind exposes them as `own-*` colors and tier breakpoints
  `tablet: compact: desk: wide:`.
- Styles: `src/styles/index.css` is a Tailwind root that scans only own-web sources (small first CSS). The
  transcript chunk has a second Tailwind root with `@opencode/ui` theme + session-ui sources (and `@opencode/ui/
styles`, `@opencode/session-ui/styles`), loaded lazily (the files and review chunks too). own-web's utilities sit in
  the last layer, `own-utilities`, after the `utilities` layer those roots fill, so their base classes never beat
  own-web's tier variants. `vite.config.ts` pre-bundles mermaid/katex in dev as `packages/app/vite.js` does.
- Upstream code without patches (own/FORK.md §7, every entry in `own/ledger/vendored.yaml`): `src/vendor/timeline/`
  (virtualizer copies), `e2e/performance/{benchmark,chrome-trace}.ts`, `vite/theme-preload.js`, and build-time
  **substitutes**: `vite/plugins.ts` `substitute()` swaps session-ui's `markdown-cache.tsx`, `markdown.tsx` and
  `markdown-worker.ts` for `src/vendor/session-ui/` copies in every importer. The cache: LRU 2,000 instead of 200 and
  DOMPurify config parsed once (PF4). The component and the worker client: a streaming answer renders incrementally
  (`src/markdown/`, SR 2026-10-20): the worker (`src/markdown/worker.ts`, upstream's plus a `tail` request) re-lexes
  only the text after the last stable block (`tail.ts`), only changed blocks are rendered and written, at most once
  per animation frame (`stream.ts`), the live block is patched in place with a fade on its newest text instead of one
  span per word (`morph.ts`), and the finished answer equals a one-shot render (`stream.test.tsx`, e2e
  `transcript.spec.ts`). An answer that never streamed renders as upstream's. A key that no import resolves to fails
  `vite build` (`markdown-worker.ts` is optional: only the other two substitutes import it).
- CSP (built `index.html` meta): `script-src 'self' 'wasm-unsafe-eval' 'sha256-<theme script>'`, `connect-src 'self'`
  - loopback http/ws, `object-src 'none'`, `base-uri 'none'`. Workers must be same-origin files
    (`new Worker(new URL("./x.worker.ts", import.meta.url), {type:"module"})`), never blob/inline. SSH endpoints
    `127.0.<k>.2` are added with own-remote (R1).

## 8. Commands

| Command                              | What                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun run dev`                        | Vite on 5173; `/api` → `OWN_WEB_API_URL` (+`OWN_WEB_API_PASSWORD`) or the local-channel registration `~/.local/state/opencode/service-local.json`; the proxy adds Basic auth server-side. `OWN_WEB_CONTROL_DIR` sets the control location                                                                                                                          |
| `bun run build`                      | Production bundle in `dist/` (`_assets/`, CSP meta)                                                                                                                                                                                                                                                                                                                |
| `bun run size`                       | PF5: initial JS/CSS gzip, top contributors, no desktop code in the first chunk (exit 1 on failure)                                                                                                                                                                                                                                                                 |
| `bun run typecheck` / `bun run test` | `bun check`; unit tests (happy-dom, `--conditions=browser`) incl. boundaries                                                                                                                                                                                                                                                                                              |
| `bun run test:e2e`                   | Playwright in the installed Edge (`channel: "msedge"`). `e2e/backend.ts` boots the real server from source with own.accounts/own.telemetry, a fake OpenAI provider, an API-key account made through RPC, three sessions, Vite dev (5199) and `vite preview` of `dist` (5198). Build first for the CSP test. State in `%TEMP%\own-web-e2e-<hash>`; `OWN_WEB_E2E_REUSE=1` attaches to a backend of this checkout started by hand (`bun e2e/backend.ts`) |
| `bun run test:e2e:sidebar`           | Sidebar suite (`src/sidebar/e2e`, own ports 5189/5188 and temp directory)                                                                                                                                                                                                                                                                                          |
| `bun run dev:service`                | `dev/serve.ts`: real server from source + both plugins, fake OpenAI (chunked streaming), fake Codex + ChatGPT issuer, fake old-app profiles (`codexImportRoot`), accounts Alpha/Bravo (keys) and 개인 Pro (device login) made through RPC, seeded sessions in two projects, then Vite dev (`--port`, default 5173; `startViteDev`, below) and optionally `--preview`. Since IMPORT `dev/service.ts` also loads own-import last with synthetic Codex and Claude Code stores written into the dev temp root; this PC's real stores only with `OWN_IMPORT_REAL_ROOTS=1` (read only) |
| `bun run test:integration`           | `e2e/integration`: Edge walkthrough against `dev:service` (port 5401): chips, IME send-once + streaming, switcher → cost dialog → applied, limits windows, add key, new session with that account, Codex import (linked), compaction settings in 2 clicks. Screenshots in `$OWN_WEB_SHOTS`                                                                         |
| `bun run test:e2e:gateway`           | M1 remote access (05 §15, MG1–MG6, MG8) in Edge: `e2e/gateway/backend.ts` builds own-web (with `sw.js`, manifest, icons), boots a real server (own.accounts + own.remote with gateway options) behind a request recorder, connects the fake-SSH host `gwbox`; a PC tab turns the gateway on and pairs 375 px phone tabs (mobile emulation). Results and screenshots in `%TEMP%\own-web-e2e-gateway-<hash>\shots`; `OWN_WEB_E2E_GATEWAY_REUSE=1` attaches to a hand-started backend of this checkout (`OWN_WEB_E2E_KEEP=1` keeps it up after the run) |
| `bun run test:e2e:remote`            | SSH remote (04 §17, RG13 on the web fallback's dev path) in Edge over own-remote's fake-SSH harness: `e2e/remote/backend.ts` boots the local server (own.accounts with the credential broker, own.remote), the fake hosts `devbox`, `pwbox`, `farbox`, `oldbox` and Vite dev (5421); remote sessions lease PC-only accounts per request. State (`backend.json`, `provider-requests.jsonl`) in `%TEMP%\own-web-e2e-remote-<hash>`, screenshots in its `shots`; `OWN_WEB_E2E_REMOTE_REUSE=1` attaches to a hand-started backend of this checkout |
| `bun run check:fallback`             | Web fallback (P-002): build, then the server itself serves `dist/` (`OPENCODE_WEB_APP=own-web`; own.accounts, own.remote, own.telemetry as in a release config; a failed resource names its request), pairing-link cookie sign-in, list/RPC/prompt over the cookie, SPA-fallback reload, server CSP, zero CSP violations. JSON report, exit 1 on failure                                                                                                                |
| `bun run test:e2e:<suite>`           | P5 feature suites on their own ports: `requests`, `review`, `terminal`, `timeline-ops`, `composer-ext`, `workspace`; `p5` is the integrator's walkthrough of items 1–15 in the whole app (`e2e/p5`, port 5511, screenshots in `$OWN_WEB_P5_SHOTS`)                                                                                                                 |
| `bun run test:e2e:<suite>` (P7)      | `review-git` (5621), `files` (5617), `worktree-bg` (5347), `composer-plus` (5287), `session-ux` (5733), `palette-shell` (5377), `linux-build` (the own-channel Linux tarballs, no server); `p7` is the integrator's walkthrough of 03 §19 items 17–32 in the whole app (`e2e/p7`, port 5711, dark default + light spot-checks, screenshots in `$OWN_WEB_P7_SHOTS`) |
| `bun run test:e2e:import`            | 다른 도구의 대화 (09, IMPORT) in Edge (ko-KR): `e2e/import/backend.ts` boots the real server from source through own-team's e2e harness (own-accounts + own-import, `importer: true`, own-team off) with synthetic Codex and Claude Code stores written by own-import's fixture builders (the server's `CODEX_HOME`/`CLAUDE_CONFIG_DIR` are empty temp folders, so this PC's `~/.codex` and `~/.claude` are never read), a Git project with a linked worktree, a second clone under a `#` folder, a non-Git folder and the I2 project `작업/이어가기` (three Codex threads, one Claude Code conversation), the fake Claude slot (`claude: true`), a responder that answers core's compaction request with a fixed summary after a settable delay, and an inspect server on 127.0.0.1 (`GET /requests`, `POST /summary?delay=`, `POST /turn`, `GET /sessions`), then Vite dev on 5781 (`OWN_WEB_IMPORT_E2E_PORT`). `import.spec.ts`: the I1 screens (sidebar row and its setting, the `⋯` item on a non-Git project, the palette, list filters and tags with the Q3 tag, title and content search, the `.zst` and Claude Code viewers, settings roots, 375 px, a keyboard path, PF5, the IG1 listing of the stores unchanged, IG10). `migrate.spec.ts` (I2, needs conversations not imported yet: a fresh backend): the `이어서 하기` flow against fake providers (entry 4, the default target and 추천, 그대로 and 열기 / 새로 가져오기, the Codex remote compaction, the LLM summary with the hidden helper, close, reload and cancel, LLM 없이, Claude Code; IG8, IG9, IG10 on screen). Build first (`bun run build`). State in `checkoutTmp("own-web-import-e2e")` (`OWN_WEB_IMPORT_E2E_TMP`), removed when the backend stops; `OWN_WEB_IMPORT_E2E_REUSE=1` attaches to a hand-started backend of this checkout |
| `bun run bench` / `bench:gate`       | `e2e/performance/run.ts` (PF1–PF5, PF7 on the production bundle; see its README)                                                                                                                                                                                                                                                                                   |

Worktrees and ports: the suites keep their fixed default ports. A run whose port already answers fails at start
(Playwright: "is already used") instead of testing that server, which may be another worktree's backend; only the
`*_REUSE=1` variables above attach to a running backend, started by hand in the same checkout. To run next to another
worktree, give one of them other ports (`OWN_WEB_E2E_DEV_PORT` with `OWN_WEB_E2E_PREVIEW_PORT`,
`OWN_WEB_E2E_GATEWAY_PORT`, `OWN_WEB_E2E_REMOTE_PORT`). `<hash>` is 8 hex digits of the SHA-256 of the checkout root's
real path (`checkoutTmp` in `e2e/gateway/support.ts`), so each checkout keeps its own state and screenshots.

Vite dev in the e2e backends and the dev service: every `e2e/**/backend.ts` and `dev/serve.ts` (`bun run dev:service`,
which the integration walkthrough starts) start Vite through `e2e/vite-dev.ts` (`startViteDev`) and call `dev.ready()`
right after writing their state file. Until then the dev port answers 503: Playwright's `webServer` check takes any
status below 404 as ready, and its runner then loads the specs, which read that state file at once (an empty
`backend.json` was read on 2026-10-16 while the shared backend still started its preview server). Each dev port keeps
its own dependency cache in `node_modules/.vite-e2e/<port>`: the shared `node_modules/.vite` is deleted and rebuilt by
the first server after a lockfile or config change, which broke every suite running at that moment (21 s without
`deps/` on 2026-10-16). Before it returns, `startViteDev` transforms every `src/**` module except tests: on a cold server
under load the review tab's lazy chunk outlasted the 20 s expect timeout (p5 "4 work panel", 2026-10-14). Costs: the
warm-up adds about 12 s to every backend start on a quiet PC (about 14 s under load, 36 s once with a cold cache next to
the own-accounts suite), so a full pass over the 20 Vite-dev backends and the walkthrough takes about 4 minutes longer;
each per-port cache is about 60 MB, up to about 1.5 GB per worktree once every suite has run. Deleting
`node_modules/.vite-e2e` (or one `<port>` folder, e.g. after an interrupted run) is safe: the next start rebuilds it.

By hand, `bun run dev:service` keeps HMR, uses `.vite-e2e/<port>` (5173 by default) and prints its URLs once the
warm-up is done and the state file is written, which is also when its port stops answering 503: about 12 s later than
before 2026-10-17. Two hand tools still share `node_modules/.vite`: `bun run dev` (the Vite CLI, no backend) and the
desktop dev shell `packages/own-desktop/scripts/dev.ts` (its own `createServer`, also on 5173 by default).

The `webServer` timeout of every suite on `startViteDev`, the integration walkthrough included, is at least 300 s: the
dev port answers only after the server boot (the own-accounts e2e harness waits up to 170 s, its `startupTimeoutMs`
default), the warm-up and the state write, and a run that outlasts it fails with Playwright's generic "Timed out
waiting … from config.webServer" instead of the backend's boot error.

## 9. Performance checklist (03 §20.2, 01 §6.6)

| Rule                   | Where it is enforced now                                                                                            | Owner follow-up                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| R1 fine-grained stores | OwnStore, SessionIndex, createData keyed by id, `reconcile(…, {key:"id"})`; rows read their own id                  | Sidebar rows subscribe to title/status/chip only |
| R2 virtualization      | Transcript (vendored virtualizer, visible rows + 2), sidebar windowed past 200 rows                                 | File tree, diff                                  |
| R3 frame batching      | EventBus: one Solid batch per rAF; own quota/cache/ledger coalesced 250 ms                                          | Side surfaces ≤4 updates/s while streaming       |
| R4 workers             | CSP allows same-origin module workers; session-ui markdown worker; markdown LRU sized for long streams (substitute) | Shiki/diff workers never call the API            |
| R5 lazy chunks         | Pages, panel tabs, desktop host lazy; `bun run size`                                                                | Every new tab/dialog lazy                        |
| R6 composer            | IME helper; placeholder composer sizes on the next frame, no layout reads in handlers                               | Draft save 500 ms debounce + idle                |
| R7 layout              | Drag changes CSS variables only; rows `contain: content`                                                            | Transcript re-measures after drag ends           |
| R8 startup             | Only the list at start; cache first; resync after connect                                                           | Only the selected session loads messages         |
| R9 one timer           | `shell/clock.ts` (1 min, paused hidden); no polling anywhere                                                        | Countdowns use it                                |
| R10 preload            | — (P4)                                                                                                              | Desktop                                          |
| R11 light metrics      | `perf/marks.ts`, `perf/event-timing.ts` (≤256 samples/30 s, type + timing only)                                     | Bench harness `e2e/performance`                  |

Measured (this PC, Edge 154 headless, integrator run `bun run bench --repeat 5`, production bundle, p95 over 5 runs):
PF1 web cached list 108 ms (fresh 144, cold 297), PF2 processing 0.3 ms / event→paint 16 ms, PF3 presented frames
4.3 ms, slow-frame ratio 0.27 %, 0 long tasks, PF4 processing 0.6 ms / event→paint 16 ms / 0 long tasks / slow frames
0.81 % / anchor jump 0 px, PF5 initial JS 165.7 KB gzip (CSS 12.6 KB), PF7 warm 20 ms (cold 135 ms). All gates pass;
PF4's slow-frame ratio is the closest to its budget (1 %, 2F = 8.3 ms on this 240 Hz display). Before the markdown
cache substitute PF4 had 126 long tasks per run (40–60 ms each, late in the 4,000-delta answer).

P7 (integrator, 2026-09-27, `bun run bench --repeat 5`, same PC with ~30 % background CPU from other apps): PF1 cached
list 235 ms (fresh 419, cold 703), PF2 0.5 ms / 16 ms, PF3 presented frames p95 8.4 ms, PF4 2 ms / 24 ms / anchor 0 px,
PF5 initial JS 251.5 KB gzip (CSS 16.6 KB; +26–30 KB from the P7 first-chunk parts), PF7 warm 48 ms (cold 588 ms,
track). The PF3/PF4 long-frame ratio gates (≤1 %) fail: 18 % / 8 %, 1 long task (51 ms) in 1 of 5 PF3 runs. An A/B of
the HEAD (pre-P7) bundle and the P7 bundle with the same harness, back to back twice (×3 each), put both in the same
range (PF3 0.30–0.43 vs 0.19–0.49, PF4 0.20–0.22 vs 0.12–0.30): Edge ran its frame clock at 120 Hz (rAF median
8.3 ms) for most runs, which the ratio (F measured idle at 4.2 ms) counts as long frames. Fixed in the harness (below).

Harness methodology (2026-09-28, `e2e/performance/README.md`):

- Long-frame ratio (03 §20.1 "> 2F") uses **F = 16.7 ms**, 01 §6.6's 60 fps budget: a long frame is a rAF interval
  above 33.4 ms, whatever the display runs at. The refresh is observed and recorded, not used as the threshold:
  `raf.refresh` per run (idle Hz before the run, active Hz = median rAF interval during it) and perf.json
  `environment.display` (Windows display mode: 240 Hz; Edge idles at 238 Hz and runs most PF3 flings at 121 Hz, PF4
  at 238 Hz). The old display-normalized count and the intervals over 16.7 ms stay in each record as diagnostics.
- Machine load is sampled every second (`os.cpus()`): `environment.load.baseline` (5 s before the backend starts =
  other applications), `environment.load.benchmarks`, `benchmarks[].cpuBusy`; a baseline ≥ 25 % marks the run busy.
- `OWN_PERF_PROFILE=tasks|1` records a profile trace per repetition and classifies every main-thread task over
  50 ms as `gc`, `descheduled` (on a CPU for < half its wall time) or `work`; `trace-tasks.ts` breaks one down.

Run after the fix (2026-09-28, `bun run bench --repeat 5`, production bundle of the working tree at 6ac581cc8f with
uncommitted work of parallel sessions, Edge 154 headless; **busy machine**: other applications used 82 % of the 12
logical CPUs before the backend started, 91 % mean / 100 % p95 while the benches ran): PF1 cached list 223 ms (fresh 346, cold 867), PF2 0.5 ms / event→paint 16 ms, PF3 presented frames 9.5 ms,
long-frame ratio 0.43 % (the display-normalized F gives 30 % on the same frames), PF4 2.9 ms / 32 ms / presented
4.3 ms / ratio 0.87 % / anchor 0 px, PF5 initial JS 252.1 KB gzip (CSS 16.7 KB), PF7 warm 52 ms (cold 368 ms, track).
The run before it (same fix; 95 % before the backend, 82 % during) passed every gate but PF3 long tasks (2 in 1 of 5
runs; ratio 0.17 %). Failing here: PF3.longTasks (1 × 120 ms) and PF4.longTasks (1 × 93 ms), one run each.

Cause (profile traces, 16 PF3/PF4 runs at 87–100 % machine CPU): 26 of the 27 tasks the Long Tasks API reported were
`descheduled`: the renderer main thread was on a CPU for 6–46 % of the task's wall time (e.g. 102 ms wall, 14 ms CPU),
so the machine was busy, not the page. One was `work`: 54 ms wall with 45 ms CPU under the same load. On a less loaded
machine (full profile) the longest page tasks of a fling are 20–32 ms wall: style recalc, the TanStack virtual-core
scroll handler (rows mounting), layout, Layerize. No own-web defect; release numbers need an idle machine (a busy
run says so in its summary).

Release run (2026-09-28, `bun run bench --repeat 5 --version 2.0.18-own.1`, the final working tree with the P8 and
integration changes, Edge 154 headless; other applications 62 % before the backend, 67 % mean / 90 % p95 during; copy
in `own/release/2.0.18-own.1/perf.json`): every gate passes. PF1 cached list 169 ms (fresh 198, cold 490), PF2 0.4 ms
/ event→paint 16 ms, PF3 presented frames 8.4 ms, long-frame ratio 0, 0 long tasks, PF4 1.2 ms / 16 ms / presented
4.32 ms / ratio 0.1 % / 0 long tasks / anchor 0 px, PF5 initial JS 252.12 KB gzip (CSS 16.94 KB), PF7 warm 48 ms (cold
341 ms, track).

Tracked, not a gate (the Long Tasks API does not report GC-only tasks, so `longTasks` never sees them): V8 major GC
pauses of 60–145 ms wall (70–88 ms CPU when not descheduled) in about one PF3 fling of four, "finalize incremental
marking via task", heap ~94 → 41 MB (PF3 `jsHeapMB` 48–104 MB before a fling). The ephemeron and weak-collection
phases are ~40 % of the pause. Owner: transcript / session-ui. Candidates, not yet proven: rows mounting while
scrolling (session-ui markdown sanitize creates DOMPurify documents on cache misses; per-row `WeakMap`s keyed by
DOM nodes in session-ui markdown and timeline rows). Main-thread time during a fling is ~60 % of the window: Layerize
~2.1 s of 10 s, style 1.1 s, the ui ScrollView and virtual-core scroll handlers ~0.9 s each (own `follow.ts` and the
vendored virtualizer < 0.25 s together).

## 10. Deviations and open items

- OwnHost shape: 03 §16.7 and 05 §6.2 each name the other as the source; this package implements 03's shape
  (capability names of the 03 table, `auth: injected|cookie|device`) plus 05's `controlDir`, `ServiceStatus.managed`
  and `restart` results. `window.zoom` is optional (03 asks 05 for it). `HostBrowserPane` is opaque until P4.
- Work panel tabs are an own accessible tablist, not `@opencode/ui/tabs` (Kobalte unmounts hidden content and needs
  the ui i18n context; the panel must keep tabs mounted and lazy).
- Router: a small own router instead of `@solidjs/router` (two modes, typed routes, smaller first chunk).
- Session list cache is IndexedDB only (05 T0-2); 01 §6.3's localStorage fast path is not needed at the measured
  ~100 ms. Revisit if desktop PF1 says otherwise. Rows carry `archived` (kept out of the list) and `outcome`; a turn
  starting (`session.execution.started`) moves its row to the top, because core does not publish `session.status`.
- `compaction.due` is executed in OwnStore (data layer) for every client with the `prompt` scope; the UI chip reads
  `own.state.compactionRequested`.
- Web fallback (01 §6.1, 12): P-001/P-002 are active (`own/ledger/core-patches.yaml`); the server serves this
  package's `dist/` with `OPENCODE_WEB_APP=own-web`. P-002 also normalizes asset keys to `/` (Windows returned
  `_assets\x.js`, so every chunk was a 404). `bun run check:fallback` verifies it end to end. The pairing redirect keeps
  the link's fragment, so the launcher passes the control location as `…/auth/connect/<code>#control=<dir>`.
- Recorded in the ledgers: `vite/theme-preload.js`, the `packages/app/vite.js` parts in `vite.config.ts`, the perf
  harness copies and the session-ui `markdown-cache`, `markdown` and `markdown-worker` substitutes
  (`own/ledger/vendored.yaml`); the theme storage keys
  (`own/upstream-surface.json` `ui-theme-storage-keys`).
- P5 integration (see the module files for each module's own deviations):
  - Feature strings stay in each module's `strings.ts` (same `t()` rules, ko + en), like the sidebar's; moving them
    into `ko.ts` would put lazy modules' strings (terminal, review panel) into the first chunk. English for the
    03 §14 keys P5 uses was added to `en.ts`.
  - Browser tool (18.15): 01 §17.1 #5 / 05 §8.7 plan D is implemented (deny rule at creation in windows without the
    pane), not 03 §18.15's install profile; 03 §5.1 "own-web은 `permissions`를 직접 만들지 않는다" conflicts with it.
    The rule goes through createData's `session.create` input, which reaches `POST /api/session{permissions}`.
  - The sidebar's own folder picker was removed; `폴더 열기…` and Ctrl+O are the projects module's (one picker).
  - Request docks use session-ui `./dock-prompt` through `src/adapter/dock-prompt.ts` instead of a copy.
  - Tool cards do not get the `[browser.disconnected]` hint line (browser tools are Code Mode calls inside `execute`);
    the session banner explains the state instead.
- P7 integration (03 §19; each module file lists its own deviations):
  - 19.1: pending line comments are kept per session in localStorage (per-viewer draft). Not restored by revert/queue
    `편집` (`draftFrom`), and server slash commands carry none. Composer chips are own-rendered (session-ui stays out of
    the first chunk); sent messages use session-ui's comment card through `withCommentPresentation`.
  - 19.2 "through the permission dock": `shell.create` has no server-side permission gate and the request docks only
    take server requests, so the Git confirmation is an own dock on the permission dock's frame (session-ui
    `DockPrompt`) inside the review tab, independent of the approval mode (03 §19.2). Git write shells set
    `metadata.source`, so they are not background jobs.
  - 19.3: the sidebar's `⑂` groups use the project's worktree list only when a view already loaded it (selector, move
    dialog), else "a folder outside the project root" — no extra requests at startup. Worktrees are created detached,
    so labels are folder names unless a branch is checked out there.
  - 19.4: the server has no working-tree file events; the tab refreshes on tool ends, turn ends, restores, `!`
    commands, branch changes, reconnects and focus (≤1 per 800 ms, none while hidden). No size check before reading
    (no stat/range API). PDFs on desktop need `frame-src 'self' blob:` (added to the build CSP). File-type icons are own
    inline icons (the ui sprite is 955 KB). Tool cards have no "파일 탭에서 열기" slot in session-ui; markdown links do.
  - 19.5: desktop `openPath` has no line argument; SSH sessions need the host's ssh config alias for the
    `vscode-remote` link.
  - 19.7: the output viewer re-reads a running shell's output once a second while open and visible (no output stream;
    the transcript's shell card does the same) — an exception to R9. Alt+B repeats `session.background` up to 4× while
    the tool registers. `SendToBackgroundButton` has no tool-card slot in session-ui; the dock row covers it. Paired
    devices lack the `terminal` scope in `HostConnection.scopes`.
  - 19.8: the backend has one `shell` value for the agent and new terminals (03 §19.8 names two); per-terminal choice
    stays in the terminal tab's ▾.
  - 19.9: shell mode is off for `auth: "device"` connections (no `terminal` scope yet).
  - 19.10: the session-info drawer does not exist yet; notes open from the header `⋯` and the palette as a dialog.
  - 19.11: rows carry only the two own flags (`SessionRow.metadata`); `session.metadata.updated` patches them and
    `session.forked` fetches the fork's row. Core stamps `updated` on every metadata write, so a pin moves the row up
    after the next list refresh.
  - 19.12: session-ui's message actions have only `revert`/`openAttachment`, so `여기서 포크` per message is the fork
    dialog from the header `⋯`/palette (preselect by message id is supported once a slot exists: `forkAction`).
  - 19.13: find covers user messages and answer text (what can be highlighted), not reasoning or tool output.
  - 03 §4.4 header `⋯` has no `삭제` yet (no delete flow in own-web).
- P8 / 05 M1 (remote access):
  - 설정 > 휴대폰·다른 PC is `src/pairing/settings.tsx` (lazy); the SAS dialog lives on that page (the pairing is started there),
    not app-wide. Countdowns (QR 5 min, approval 2 min) tick once a second only while shown, and the device's pairing
    screen polls `/own/pairing` every 1.5 s while visible (no event stream without a credential): R9 exceptions.
  - PWA: `src/pwa/vite.ts` emits `sw.js` (from `sw.ts`, a classic script), `manifest.webmanifest` and PNG/SVG icons
    into `dist/`; only the mobile host registers the worker (gateway origin only, 01 §6.1). It caches the app shell
    (network-first page, cache-first hashed assets) and never `/srv/*/api`, `/own`, `/auth`; the offline list is the
    existing IndexedDB snapshot.
  - Phone tier at 375 px (checked by e2e/gateway): `.own-app { overflow: clip }` (hidden columns never widen the page),
    a two-line phone header (back · title · ⋯ · panel, then badge and pills; theme toggle in 설정 > 일반), and
    `(pointer: coarse)` minimums of 44 px for the shared control classes (`!important`: module stylesheets are
    unlayered) plus `own-target` on sidebar/settings controls and session-ui's message actions in the transcript.
  - `data.get(key)` is reactive (a runtime generation signal): a view opened on `/srv/<hostId>/…` before the host's
    runtime exists (reload, direct link) picks it up.
  - The permission dock hides `항상 허용` (and Mod+Enter allows once) on `auth: "device"` connections (05 §13.5).
  - A device's `files`/`terminal` scopes guard upstream HTTP at the gateway; `HostConnection.scopes` carries only the
    `own.accounts` ones, so the terminal and shell mode stay off for devices as before.
- Computer use (01 §10.2, 03 §5.7 실험):
  - The switch "이 세션에서 컴퓨터 사용" is a dialog opened from the session `⋯` (and from the header chip once on): there
    is no work-panel tab for it. Turning it on asks once (what the agent does, how to stop, what stays denied, the
    catalog note); turning it off does not. Like the browser switch, a `custom` session (`mode` is required) or a
    service whose own.accounts lacks `computerUse` cannot be switched here; the dialog says why.
  - Only local sessions, not subagent sessions (the plugin refuses them by default; the parent's switch covers them).
  - `status` carries no display list (the plugin answers it without starting its helper), so the panel shows the
    driver, helper, app policy, lease holder, per-session grants and the audit lines, not monitors.
- Claude subscription on SSH hosts (04 §8.11, T11):
  - One verdict per host in `servers/claude.ts`: this PC's `hosts.list` row (`broker.claude`, `broker.state`) first,
    then the host's `health.claudeSlot` (mirrored verdict, `conflict`). It drives the switcher's reason row (an empty
    Claude group on a host says why, with `계정 관리…` or `호스트 상태`), `PC 경유` in the switcher and the header pill,
    the new-session default (Claude on a host only while `enabled`, also for a folder's last Claude session) and the
    word of a host on the Claude card and in 설정 > SSH 원격 호스트. The relay verdict has no own.remote event:
    `RemoteStore.refreshBroker()` re-reads `hosts.list` (broker views only) when the switcher opens on a host, when the
    Claude card mounts or switches, and on this PC's `accounts.changed` (`RemoteLayer`).
  - The Claude card's `SSH 원격 호스트에서 쓰기` (`accounts/claude-remote.ts` flow, `ClaudeRemote` in claude-slot.tsx):
    notice (the copy of own-accounts' `REMOTE_TEXT`, compared in accounts.test.ts) → `remote.ack` → `remote.set`,
    switches only where `remote.set` may be called; a notice copy whose hash differs from `status.remote.noticeHash`
    is not shown (`own.acct.claudeAckStale`).
  - Fast on a remote session (`composer/speed.ts` `setSpeed`): the consent card says `fastLocal`, this PC's
    `plugin.claudeAuth.fastAck` records it, then the host's `session.speed.set` is asked again every 500 ms for at most
    10 s (a bounded wait, an R9 exception).
  - Deviation: 04 §8.11.13 puts every `own.remote.*` word in `remote/strings.ts`; `claudeSlot.badge`, `badgeHelp` and
    `fastLocal` are first-chunk words (header pill, composer), so they are in `servers/strings.ts` like the other
    first-chunk `own.remote.*` keys.
- TODO: Pretendard subset font (R5; the first Hangul keystroke paints in 136–192 ms, likely font fallback), PF6/PF8
  (packaged desktop, P4), 401 detection for the "인증 필요" screen, phone new-session flow, the session-info drawer
  (`own:open-session-info`).
