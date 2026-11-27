// Shots added with the 2026-10-10 manual update (notes, voice input, the model pool, subagent effort, the Claude card's
// SSH section, area peers, the heavy-folder list that follows the project). Group M's run after the main world's own
// shots; group T's after 17-enable (they need the team it turns on). Same demo worlds, fake accounts and keys only.
import type { Locator, Page } from "../lib/browser"
import type { Ctx, Shot } from "../lib/ctx"
import type { MainState } from "./main"

type C = Ctx<MainState>
const shot = (id: string, run: (ctx: C) => Promise<void>): Shot<MainState> => ({ id, run })
const tid = (page: Page | Locator, id: string) => page.getByTestId(id)

async function closePanel(page: Page) {
  if (await tid(page, "panel").isVisible().catch(() => false)) await tid(page, "panel-toggle").first().click()
  await page.waitForTimeout(300)
}

/** A page of the app (`/accounts`, `/settings/<section>`, …) without the right panel. */
async function open(ctx: C, path: string) {
  const page = await ctx.page({ path })
  await page.waitForTimeout(1500)
  await closePanel(page)
  return page
}

/** Types into the composer of the open session. */
async function type(page: Page, text: string) {
  const input = tid(page, "composer").locator("[contenteditable=true], textarea").first()
  await input.click()
  await input.fill(text)
}

async function send(page: Page, text: string) {
  await type(page, text)
  await page.keyboard.press("Control+Enter")
}

/** `모델 묶음으로 돕기`: a model-pool preset of the ChatGPT group (saved once; later calls find it). */
async function poolPreset(ctx: C) {
  const list = await ctx.rpc("own.accounts", "presets.list", { group: "codex" })
  if (JSON.stringify(list.output ?? "").includes("모델 묶음으로 돕기")) return
  const saved = await ctx.rpc("own.accounts", "presets.set", {
    preset: {
      name: "모델 묶음으로 돕기",
      group: "codex",
      workers: {
        mode: "same",
        roles: {},
        pool: [
          { key: "gpt-5.5", model: "gpt-5.5" },
          { key: "spark", model: "gpt-5.3-codex-spark", note: "파일 찾기처럼 가벼운 일에" },
          { key: "opus", model: "claude-opus-5-5", account: ctx.state.accounts.claude, note: "리뷰는 다른 회사 눈으로" },
        ],
      },
      delegation: "when-useful",
      caps: { concurrent: 3, perMessage: 6, perSession: null },
      ultraCaps: null,
    },
  })
  if (saved.status !== 200) throw new Error(`presets.set (pool): ${saved.status} ${saved.message}`)
}

/** The workspace `노트` tab of the open project (its right column), opened from the header toggle. */
async function notesTab(page: Page) {
  const panel = tid(page, "workspace-notes")
  if (!(await panel.isVisible().catch(() => false))) await tid(page, "workspace-notes-toggle").first().click()
  await panel.waitFor()
  await panel.locator("[data-synced]").or(panel).first().waitFor()
  await page.waitForTimeout(800)
  return panel
}

/** Opens a saved note of the notes tab by its title (`저장된 노트 열기`). */
async function openNote(page: Page, title: string) {
  const panel = tid(page, "workspace-notes")
  await panel.getByLabel("저장된 노트 열기").selectOption({ label: title })
  await page.waitForFunction(
    (wanted) => (document.querySelector<HTMLInputElement>("[data-testid=workspace-notes] .own-note-title")?.value ?? "") === wanted,
    title,
    { timeout: 15_000 },
  )
  await page.waitForTimeout(500)
}

/** Types a title and text into the open note of the notes tab. */
async function writeNote(page: Page, title: string, text: string) {
  const panel = tid(page, "workspace-notes")
  await panel.getByLabel("노트 제목").fill(title)
  await panel.getByLabel("노트 내용").fill(text)
  await panel.getByLabel("노트 내용").blur()
  await page.waitForTimeout(800)
}

/** Voice input on, with a made-up OpenAI key for dictation only (never a real key; nothing is transcribed). */
async function voiceOn(ctx: C) {
  const on = await ctx.rpc("own.accounts", "voice.set", { enabled: true, provider: "openai", language: "ko" })
  if (on.status !== 200) throw new Error(`voice.set: ${on.status} ${on.message}`)
  const key = await ctx.rpc("own.accounts", "voice.key.set", { provider: "openai", key: "sk-demo-voice-0000" })
  if (key.status !== 200) throw new Error(`voice.key.set: ${key.status} ${key.message}`)
}

/** `getUserMedia` answered by an oscillator through the page's own audio context (a level meter that moves). */
const FAKE_MIC = `(() => {
  const media = navigator.mediaDevices;
  if (!media) return;
  media.getUserMedia = async () => {
    const audio = new AudioContext();
    const tone = audio.createOscillator();
    const wobble = audio.createOscillator();
    const depth = audio.createGain();
    const gain = audio.createGain();
    tone.frequency.value = 220;
    wobble.frequency.value = 3;
    depth.gain.value = 0.25;
    gain.gain.value = 0.35;
    wobble.connect(depth).connect(gain.gain);
    const out = audio.createMediaStreamDestination();
    tone.connect(gain).connect(out);
    tone.start();
    wobble.start();
    return out.stream;
  };
})()`

export const UPDATES_MAIN: ReadonlyArray<Shot<MainState>> = [
  shot("10-thread-note", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await closePanel(page)
    await tid(page, "session-menu").click()
    await tid(page, "session-menu-notes").click()
    const dialog = tid(page, "notes-dialog")
    await dialog.waitFor()
    await tid(dialog, "notes-input").fill("모서리에서 적이 멈추는지 내일 다시 확인하기. 보스 방은 아직 안 봤음.")
    await tid(dialog, "notes-save").click()
    await tid(dialog, "notes-status").filter({ hasText: "저장했어요" }).waitFor()
    await ctx.shoot(page, "10-thread-note", {
      clip: dialog,
      marks: [tid(dialog, "notes-input"), tid(dialog, "notes-model-toggle").locator("xpath=ancestor::label[1]")],
    })
    await page.keyboard.press("Escape")
  }),
  shot("10-notes-tab", async (ctx) => {
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await closePanel(page)
    await notesTab(page)
    const panel = tid(page, "workspace-notes")
    // Two notes of the project: typed like a user would (saved on the PC's service as they are typed).
    await writeNote(page, "다음 할 일", "1. 보스 공격 패턴 테스트\n2. 로비 6명 확인\n3. HUD 글자 크기 맞추기")
    await tid(panel, "note-add").click()
    await writeNote(page, "버그 메모", "적이 대각선 모서리에서 가끔 멈춤 (레벨 3, 왼쪽 위)")
    await tid(panel, "note-save-status").filter({ hasText: "PC에 저장됨" }).waitFor({ timeout: 30_000 })
    await page.waitForTimeout(800)
    await ctx.shoot(page, "10-notes-tab", {
      marks: [
        [panel.getByRole("tablist").first(), tid(panel, "note-add")],
        tid(panel, "note-save-status"),
        panel.locator(".own-note-foot"),
      ],
    })
  }),
  shot("10-notes-conflict", async (ctx) => {
    // This window cannot save for a moment; another window changes the same note; then this one saves again.
    const page = await ctx.session(ctx.state.sessions.enemy!)
    await closePanel(page)
    await notesTab(page)
    const panel = tid(page, "workspace-notes")
    await openNote(page, "버그 메모")
    await page.route("**/api/rpc/own.accounts/notes.put**", (route) => route.abort())
    await panel.getByLabel("노트 내용").fill("적이 대각선 모서리에서 가끔 멈춤 (레벨 3, 왼쪽 위)\n벽 두께가 1칸일 때만 그럼")
    await panel.getByLabel("노트 내용").blur()
    await tid(panel, "note-save-status").filter({ hasText: "저장 실패" }).waitFor({ timeout: 30_000 })
    const other = await ctx.session(ctx.state.sessions.enemy!)
    await closePanel(other)
    await notesTab(other)
    const otherPanel = tid(other, "workspace-notes")
    await openNote(other, "버그 메모")
    await otherPanel.getByLabel("노트 내용").fill("적이 대각선 모서리에서 가끔 멈춤 (레벨 3, 왼쪽 위)\n휴대폰에서 덧붙임: 레벨 5에서도 봤음")
    await otherPanel.getByLabel("노트 내용").blur()
    await tid(otherPanel, "note-save-status").filter({ hasText: "PC에 저장됨" }).waitFor({ timeout: 30_000 })
    await page.unroute("**/api/rpc/own.accounts/notes.put**")
    // The status line's link sits in the narrow head beside the title (not "visible" to a pointer click there).
    await panel.getByRole("button", { name: "다시 저장" }).evaluate((element) => (element as HTMLElement).click())
    const conflict = tid(panel, "note-conflict")
    await conflict.waitFor({ timeout: 30_000 })
    await page.waitForTimeout(500)
    await ctx.shoot(page, "10-notes-conflict", {
      clip: panel,
      pad: 8,
      marks: [conflict],
    })
    // Keep this window's text (the note ends as the user typed it here).
    await conflict.getByRole("button", { name: "내 내용으로 저장" }).click()
    await page.waitForTimeout(1000)
  }),
  shot("10-voice-settings", async (ctx) => {
    await voiceOn(ctx)
    const page = await open(ctx, "/settings/voice")
    await page.setViewportSize({ width: 1440, height: 1500 })
    const settings = tid(page, "settings-voice")
    await settings.waitFor()
    await tid(page, "voice-ready").waitFor()
    await page.waitForTimeout(600)
    await ctx.shoot(page, "10-voice-settings", {
      clip: settings,
      pad: 12,
      marks: [
        tid(page, "voice-enabled"),
        [tid(page, "voice-provider"), tid(page, "voice-language")],
        tid(page, "voice-key-openai"),
        tid(page, "voice-shortcut"),
      ],
    })
  }),
  shot("10-voice-recording", async (ctx) => {
    await voiceOn(ctx)
    // A made-up microphone (a quiet tone from the page's own audio context): no device of this PC is opened.
    const page = await ctx.page({ path: false })
    await page.addInitScript(FAKE_MIC)
    await page.goto(`/srv/local/s/${ctx.state.sessions.enemy!}`)
    await tid(page, "composer").first().waitFor({ timeout: 60_000 })
    await page.waitForTimeout(1500)
    await closePanel(page)
    await type(page, "보스 방 입구에서 ")
    await tid(tid(page, "composer-voice"), "voice-start").click()
    const bar = page.getByRole("group", { name: "듣는 중" })
    await bar.waitFor({ timeout: 15_000 })
    await page.waitForTimeout(4200)
    await ctx.shoot(page, "10-voice-recording", {
      clip: tid(page, "composer"),
      marks: [bar],
    })
    await tid(page, "voice-cancel").click()
  }),
  shot("14-pool-editor", async (ctx) => {
    await poolPreset(ctx)
    const page = await open(ctx, "/settings/presets")
    await page.setViewportSize({ width: 1440, height: 1300 })
    await tid(page, "presets-row").filter({ hasText: "모델 묶음으로 돕기" }).getByTestId("presets-edit").click()
    const pool = tid(page, "preset-pool")
    await pool.waitFor()
    await page.waitForTimeout(800)
    await ctx.shoot(page, "14-pool-editor", {
      clip: tid(page, "preset-editor"),
      pad: 0,
      marks: [
        tid(page, "preset-editor-workers").getByRole("radio", { name: /모델 묶음에서 알아서/ }).locator("xpath=ancestor::label[1]"),
        pool.locator("[data-testid=preset-pool-row][data-checked]").first(),
        tid(page, "preset-pool-recommended"),
        tid(page, "preset-pool-defaults"),
      ],
    })
  }),
  shot("14-pool-list", async (ctx) => {
    await poolPreset(ctx)
    const page = await open(ctx, "/settings/presets")
    await page.setViewportSize({ width: 1440, height: 1300 })
    await tid(page, "presets-row").filter({ hasText: "모델 묶음으로 돕기" }).getByTestId("presets-edit").click()
    const pool = tid(page, "preset-pool")
    await pool.waitFor()
    const paid = tid(pool, "preset-pool-paid")
    await paid.click()
    await page.waitForTimeout(600)
    const defaults = tid(pool, "preset-pool-defaults")
    await defaults.evaluate((element) => element.scrollIntoView({ block: "end" }))
    await page.waitForTimeout(600)
    await ctx.shoot(page, "14-pool-list", {
      clip: tid(page, "preset-editor"),
      pad: 0,
      marks: [pool.locator("[data-testid=preset-pool-row]").last(), defaults],
    })
  }),
  shot("14-pool-details", async (ctx) => {
    await poolPreset(ctx)
    const page = await open(ctx, "/settings/presets")
    await page.setViewportSize({ width: 1440, height: 1600 })
    await tid(page, "presets-row").filter({ hasText: "모델 묶음으로 돕기" }).getByTestId("presets-edit").click()
    await tid(page, "preset-editor-details").click()
    const pool = tid(page, "preset-detail-pool")
    await pool.waitFor()
    await pool.evaluate((element) => element.scrollIntoView({ block: "start" }))
    await page.waitForTimeout(800)
    await ctx.shoot(page, "14-pool-details", {
      clip: pool,
      pad: 12,
      marks: [
        tid(pool, "preset-detail-pool-entry").nth(1),
        [tid(page, "preset-detail-pool-defaults"), tid(page, "preset-detail-refresh-cards")],
      ],
    })
    const effort = tid(page, "preset-detail-effort-max")
    await effort.evaluate((element) => element.scrollIntoView({ block: "center" }))
    await page.waitForTimeout(600)
    await ctx.shoot(page, "14-effort-setting", { clip: effort, pad: 12, marks: [tid(page, "preset-detail-effort-max-level")] })
  }),
  shot("14-effort-chip", async (ctx) => {
    // A preset that lets the conversation raise a helper's effort only up to 높음; the main asks for 최대.
    const saved = await ctx.rpc("own.accounts", "presets.set", {
      preset: {
        name: "리뷰는 높음까지",
        group: "codex",
        workers: { mode: "same", roles: {} },
        delegation: "when-useful",
        caps: { concurrent: 3, perMessage: 6, perSession: null },
        ultraCaps: null,
        subagentEffortMax: "high",
      },
    })
    if (saved.status !== 200) throw new Error(`presets.set: ${saved.status} ${saved.message}`)
    const presetID = (saved.output as { preset: { id: string } }).preset.id
    const session = ctx.state.sessions.map!
    const applied = await ctx.rpc("own.accounts", "session.preset.apply", { sessionID: session, presetID }, ctx.state.project)
    if (applied.status !== 200) throw new Error(`session.preset.apply: ${applied.status} ${applied.message}`)
    const page = await ctx.session(session)
    await closePanel(page)
    await send(page, "길찾기 변경을 리뷰해 줘. 리뷰는 최대로 꼼꼼하게.")
    const chip = page.locator('[data-testid=subagent-preset-rejected][data-kind="effortCap"]').last()
    await chip.waitFor({ timeout: 60_000 })
    await tid(chip, "subagent-chip-effort-allow").waitFor({ timeout: 15_000 })
    await chip.evaluate((element) => element.scrollIntoView({ block: "center" }))
    await page.waitForTimeout(800)
    await ctx.shoot(page, "14-effort-chip", {
      clip: [page.getByText("리뷰는 최대로 꼼꼼하게").last(), chip],
      marks: [tid(chip, "subagent-preset-rejected-text"), tid(chip, "subagent-chip-effort-allow")],
    })
  }),
  shot("20-claude-remote", async (ctx) => {
    const page = await open(ctx, "/accounts")
    // The slot's own block after every Claude account's card (SLM, 2026-11-22), no longer inside account 1's card.
    const block = page.locator("[data-testid=claude-section] [data-testid=claude-remote-block]").first()
    await block.waitFor()
    const remote = tid(block, "claude-remote")
    await remote.scrollIntoViewIfNeeded()
    await page.waitForTimeout(600)
    await ctx.shoot(page, "20-claude-remote", { clip: block, marks: [remote] })
  }),
]

// ---- Group T (team mode on space-game, after 17-enable) ----

interface TeamView {
  readonly team: { readonly id: string; readonly main: { readonly sessionID: string } } | null
  readonly areas: ReadonlyArray<{ readonly id: string; readonly name: string; readonly owner: { readonly sessionID: string | null } }>
}

async function team(ctx: C) {
  const result = await ctx.rpc("own.team", "team.get", { directory: ctx.state.project }, ctx.state.control)
  if (result.status !== 200) throw new Error(`team.get: ${result.status} ${result.message}`)
  const view = result.output as TeamView
  if (!view.team) throw new Error("space-game has no team (run 17-enable first)")
  return { ...view, team: view.team }
}

const areaRow = (page: Page, name: string) =>
  tid(page, "area-row").filter({ has: tid(page, "area-label").filter({ hasText: new RegExp(`^${name} · `) }) })

/** `시뮬`, a peer of 게임 로직 (added once, like `동료 추가…`). */
async function peer(ctx: C) {
  const view = await team(ctx)
  const area = view.areas.find((item) => item.name === "게임 로직")
  if (!area) throw new Error("no area 게임 로직")
  const listed = await ctx.rpc("own.team", "team.get", { directory: ctx.state.project }, ctx.state.control)
  if (JSON.stringify(listed.output).includes("\"시뮬\"")) return view
  const added = await ctx.rpc(
    "own.team",
    "area.peer.add",
    {
      teamID: view.team.id,
      areaID: area.id,
      create: { label: "시뮬", role: "게임 규칙을 바꾸면 시뮬레이션을 돌려 결과를 알립니다" },
    },
    ctx.state.control,
  )
  if (added.status !== 200) throw new Error(`area.peer.add: ${added.status} ${added.message}`)
  return view
}

export const UPDATES_TEAM: ReadonlyArray<Shot<MainState>> = [
  shot("17-peer", async (ctx) => {
    const view = await peer(ctx)
    const page = await ctx.session(view.team.main.sessionID)
    await closePanel(page)
    const row = page.locator('[data-testid=session-row][data-team-role="peer"]').first()
    await row.waitFor({ timeout: 60_000 })
    await page.waitForTimeout(1000)
    const area = areaRow(page, "게임 로직").first()
    await ctx.shoot(page, "17-peer", { clip: [area, row], pad: 12, marks: [area, row] })
    await area.click({ button: "right" })
    const menu = tid(page, "area-menu")
    await menu.waitFor()
    await tid(menu, "area-menu-peers").waitFor()
    await page.waitForTimeout(500)
    await ctx.shoot(page, "17-peer-menu", {
      clip: menu,
      marks: [tid(menu, "area-menu-addPeer"), tid(menu, "area-menu-peers")],
    })
    await page.keyboard.press("Escape")
  }),
  shot("17-heavy-grew", async (ctx) => {
    const view = await team(ctx)
    const set = await ctx.rpc(
      "own.team",
      "settings.set",
      { teamID: view.team.id, patch: { policy: { askDiskBytes: 30_000 } } },
      ctx.state.control,
    )
    if (set.status !== 200) throw new Error(`settings.set: ${set.status} ${set.message}`)
    const page = await ctx.session(view.team.main.sessionID)
    await closePanel(page)
    // Simulation output lands in the project after the team was set up (a new commit of the main folder).
    const saved = await ctx.control("save", {
      dir: ctx.state.project,
      files: {
        "sim/run.ts": "console.log('시뮬레이션')\n",
        "sim/output/run1.csv": "1,".repeat(12_000),
        "sim/output/run2.csv": "2,".repeat(12_000),
      },
      message: "시뮬레이션 결과",
    })
    if (saved.ok !== true) throw new Error(`save: ${JSON.stringify(saved)}`)
    // The end of a team conversation's run measures the new commit.
    const box = page.locator("#own-composer-input")
    await box.click()
    await box.fill("팀 상태를 확인해 주세요")
    await box.press("Control+Enter")
    const card = page.locator('[data-testid="team-card"][data-kind="heavy"][data-state="done"]').first()
    await card.waitFor({ timeout: 180_000 })
    await page.waitForTimeout(1000)
    await ctx.shoot(page, "17-heavy-grew", {
      clip: card,
      marks: [tid(card, "team-card-line").filter({ hasText: "프로젝트에 생긴 큰 파일 폴더" }).first(), tid(card, "team-card-undo")],
    })
  }),
]
