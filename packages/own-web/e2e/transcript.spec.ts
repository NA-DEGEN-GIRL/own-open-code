// Transcript (03 §4.5, §18.11) in Edge. Harness scenarios run the real module on fixture sessions (no server): rows,
// turn footers (with the output speed), the chat view toggles (`보기` menu), UI-only markers, the undone-switch
// collapse, follow/no-jump while streaming, a streamed answer ending exactly as a one-shot render (the incremental
// markdown of src/markdown/), history paging, the child breadcrumb and the session view cache. The last scenario
// drives the real server (e2e/backend.ts): a prompt
// through the fake provider, a compaction and an account switch, all reaching the transcript through events and
// the own.accounts ledger.
import { expect, test, type Page } from "@playwright/test"
import { BENCH, CORPUS } from "../src/markdown/corpus"
import { backend, sepsLines, watchErrors } from "./support"

type Harness = {
  __transcript: {
    open(id: string): void
    route(): { name: string; sessionID?: string }
    pages(): number
    loaded(id: string): number
    messages(id: string): { id: string; type: string; time: { created: number }; model?: unknown; previous?: unknown }[]
    stream(input: {
      sessionID: string
      deltas?: number
      perSecond: number
      text?: string
      chunk?: number
    }): Promise<{ durationMs: number }>
    once(text: string): Promise<void>
    recordSwitch(input: { sessionID: string; from: unknown; to: unknown; strategy: string; created: number }): void
    selectModel(input: { sessionID: string; model: unknown; previous: unknown }): void
    switchState(input: { sessionID: string; detail: Record<string, unknown> }): void
    commitRevert(sessionID: string, text: string): void
  }
}

const HARNESS = "/e2e/transcript-harness.html"

async function openHarness(page: Page, query = "") {
  await page.goto(`${HARNESS}${query}`)
  await page.waitForFunction(() => "__transcript" in window)
}

async function openSession(page: Page, sessionID: string) {
  await page.evaluate((id) => (window as unknown as Harness).__transcript.open(id), sessionID)
  const body = page.locator(`[data-testid="transcript-body"][data-session-id="${sessionID}"]`)
  await expect(body).toBeVisible()
  return body
}

function geometry(page: Page, sessionID: string) {
  return page.evaluate((id) => {
    const content = document.querySelector(
      `[data-testid="transcript-body"][data-session-id="${id}"] [data-timeline-virtual-content]`,
    )
    const scroller = content?.parentElement as HTMLElement
    return { top: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight }
  }, sessionID)
}

test.describe("transcript on fixture sessions", () => {
  test("session-ui rows, turn footer with ledger credits, step table", async ({ page }) => {
    const errors = watchErrors(page)
    await openHarness(page)
    const body = await openSession(page, "ses_small")
    await expect(body.getByText("12번째 요청")).toBeVisible()
    const footer = body.getByTestId("turn-footer").last()
    await expect(footer).toBeVisible()
    // ● 개인 Pro · GPT-5.6 Sol · 입력 … (캐시 …%) · 출력 … · ≈… cr 추정 · …초
    await expect(footer).toContainText("개인 Pro")
    await expect(footer).toContainText("GPT-5.6 Sol")
    await expect(footer).toContainText(/입력 \d+(\.\d)?k \(캐시 \d+%\)/)
    await expect(footer).toContainText(/≈\d+\.\d cr/)
    await expect(footer).toContainText("추정")
    await expect(footer.getByTestId("step-table")).toHaveCount(0)
    await footer.getByRole("button").click()
    await expect(footer.getByTestId("step-table").locator("tbody tr")).toHaveCount(4)
    expect(errors).toEqual([])
  })

  test("switch markers are UI-only; an undone switch collapses; live switch.recorded adds the method", async ({
    page,
  }) => {
    await openHarness(page)
    const body = await openSession(page, "ses_mark")
    // Fixture tail: A→B, B→A (undo, no step between), A→A(low): one variant marker, no account marker.
    const markers = body.getByTestId("switch-marker")
    await expect(markers).toHaveCount(1)
    await expect(markers).toContainText("추론 강도 변경")
    await expect(markers).toContainText("high → low")
    await expect(markers).toContainText("화면 전용")
    await expect(markers).toHaveAttribute("role", "note")
    await expect(markers).toHaveAttribute("title", /화면 전용이며 모델에 전달되지 않아요/)
    // The footer of the turn stays above the marker that followed it.
    const order = await body.evaluate((root) =>
      [...root.querySelectorAll('[data-testid="turn-footer"], [data-testid="switch-marker"]')].map((item) =>
        item.getAttribute("data-testid"),
      ),
    )
    expect(order.at(-1)).toBe("switch-marker")

    const last = await page.evaluate(() =>
      (window as unknown as Harness).__transcript
        .messages("ses_mark")
        .findLast((item) => item.type === "model-switched"),
    )
    await page.evaluate(
      (message) =>
        (window as unknown as Harness).__transcript.recordSwitch({
          sessionID: "ses_mark",
          from: message!.previous,
          to: message!.model,
          strategy: "compact-then-switch",
          created: message!.time.created,
        }),
      last,
    )
    await expect(markers).toContainText("압축 후 전환")
    await expect(markers.getByTestId("switch-rewrite")).toContainText("추정")
  })

  test("chat view (4.5 대화 보기): t/s in the footer, each toggle, 대화만 보기 and back, kept after a reload", async ({
    page,
  }) => {
    const errors = watchErrors(page)
    await openHarness(page)
    await page.evaluate(() => localStorage.removeItem("own.web.chat.view"))
    await page.reload()
    await page.waitForFunction(() => "__transcript" in window)
    let body = await openSession(page, "ses_small")
    let footer = body.getByTestId("turn-footer").last()
    // The fixture's steps have no first-output time on text, so the speed is the request-timed `≈`.
    await expect(footer.locator('[data-slot="speed"]')).toHaveText(/^≈\d+(\.\d)? t\/s$/)
    await expect(footer.locator('[data-slot="speed"]')).toHaveAttribute("data-basis", "request")
    await expect(footer.getByRole("button")).toHaveAttribute("aria-label", /t\/s/)
    await footer.getByRole("button").click()
    await expect(footer.getByTestId("step-table").locator("thead")).toContainText("속도")
    await expect(footer.getByTestId("step-table").locator('[data-slot="step-speed"]').first()).toHaveText(/t\/s/)
    await footer.getByRole("button").click()

    const menu = page.getByTestId("chat-view-menu")
    const item = (key: string) => page.getByTestId(`chat-view-${key}`)
    await menu.click()
    await expect(item("usage")).toHaveAttribute("role", "menuitemcheckbox")
    await expect(item("usage")).toHaveAttribute("aria-checked", "true")
    // 날짜·시각 (UC 2026-10-18): off at first, next to 걸린 시간; on, a prompt gets its date and time above it (the hover
    // time goes) and the footer and the step table get the answer's.
    await expect(item("time")).toContainText("걸린 시간")
    await expect(item("clock")).toContainText("날짜·시각")
    await expect(item("clock")).toHaveAttribute("aria-checked", "false")
    await expect(body.getByTestId("message-clock")).toHaveCount(0)
    await item("clock").click()
    await expect(item("clock")).toHaveAttribute("aria-checked", "true")
    // Kept on across a reload, and drawn from the first render too.
    await page.reload()
    await page.waitForFunction(() => "__transcript" in window)
    body = await openSession(page, "ses_small")
    footer = body.getByTestId("turn-footer").last()
    const clock = body.getByTestId("message-clock").first()
    await expect(clock).toHaveText(/^(\d{4}년 )?\d{1,2}월 \d{1,2}일 (오전|오후) \d{1,2}:\d{2}$/)
    await expect(clock.locator("time")).toHaveAttribute("title", /^보낸 시각: .+ (오전|오후) \d{1,2}:\d{2}:\d{2}$/)
    await expect(body).toHaveAttribute("data-hide", "stamp")
    await expect(footer.locator('[data-slot="clock"]')).toHaveText(/\d{1,2}월 \d{1,2}일 (오전|오후) \d{1,2}:\d{2}$/)
    await expect(footer.locator('[data-slot="clock"]')).toHaveAttribute("title", /^시작: .+ · 끝: .+/)
    await page.keyboard.press("Escape")
    await footer.getByRole("button").click()
    await expect(footer.getByTestId("step-table").locator("thead")).toContainText("시각")
    await expect(footer.locator('[data-slot="step-clock"]').first()).toHaveText(/^(오전|오후) \d{1,2}:\d{2}:\d{2}$/)
    await footer.getByRole("button").click()
    await menu.click()
    await item("clock").click()
    await expect(body.getByTestId("message-clock")).toHaveCount(0)
    await expect(body).not.toHaveAttribute("data-hide", /./)
    // Several items in a row: the menu stays open.
    await item("usage").click()
    await expect(item("usage")).toHaveAttribute("aria-checked", "false")
    await expect(footer.locator('[data-slot="input"]')).toHaveCount(0)
    await expect(footer.locator('[data-slot="cost"]')).toHaveCount(0)
    await expect(footer.locator('[data-slot="model"]')).toHaveText("GPT-5.6 Sol")
    await expect(footer.locator('[data-slot="speed"]')).toHaveCount(1)
    // One speed per answer (US6-20): the footer's; session-ui's on the answer's meta line (5a750e64a2) never shows.
    const metaSpeed = body.locator('[data-slot="text-part-meta-speed"]').first()
    await expect(metaSpeed).toBeAttached()
    expect(await metaSpeed.evaluate((element) => getComputedStyle(element).display)).toBe("none")
    await item("speed").click()
    await expect(footer.locator('[data-slot="speed"]')).toHaveCount(0)
    await expect(body).not.toHaveAttribute("data-hide", /./)
    await item("time").click()
    await expect(footer.locator('[data-slot="time"]')).toHaveCount(0)
    await expect(body).toHaveAttribute("data-hide", "time")
    const display = (selector: string) =>
      body
        .locator(selector)
        .first()
        .evaluate((element) => getComputedStyle(element).display)
    expect(await display('[data-slot="text-part-meta"]')).toBe("none")
    // Since upstream v2.2.5 a prompt's time is only in its menu, never on the meta line.
    await expect(body.locator('[data-slot="user-message-meta"] time')).toHaveCount(0)
    await item("model").click()
    await expect(body).toHaveAttribute("data-hide", "model time")
    // Account, model, usage, speed and time all hidden: no footer at all.
    await expect(body.getByTestId("turn-footer")).toHaveCount(0)

    // Tool calls: the fixture's read and shell steps leave the timeline; thinking and subagents have no rows here.
    const toolRows = () =>
      body.locator('[data-component="context-tool-group-trigger"], [data-component="tool-trigger"]')
    const before = await toolRows().count()
    expect(before).toBeGreaterThan(0)
    await item("tools").click()
    await expect(toolRows()).toHaveCount(0)
    await expect(body.getByText("12번째 요청")).toBeVisible()

    // 대화만 보기 hides the rest; off brings back exactly what was shown before (usage, speed, time, model, tools off).
    await page.getByTestId("chat-view-only").click()
    await expect(page.getByTestId("chat-view-only")).toHaveAttribute("aria-checked", "true")
    for (const key of ["thinking", "subagents", "markers", "changes"])
      await expect(item(key)).toHaveAttribute("aria-checked", "false")
    await page.getByTestId("chat-view-only").click()
    await expect(item("markers")).toHaveAttribute("aria-checked", "true")
    await expect(item("tools")).toHaveAttribute("aria-checked", "false")
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("chat-view-popover")).toBeHidden()
    await expect(menu).toHaveAttribute("aria-label", /5개 숨김/)

    // Per viewer, kept across reloads.
    await page.reload()
    await page.waitForFunction(() => "__transcript" in window)
    body = await openSession(page, "ses_small")
    await expect(body).toHaveAttribute("data-hide", "model time")
    await expect(body.getByTestId("turn-footer")).toHaveCount(0)
    await page.getByTestId("chat-view-menu").click()
    await page.getByTestId("chat-view-reset").click()
    footer = body.getByTestId("turn-footer").last()
    await expect(footer.locator('[data-slot="input"]')).toBeVisible()
    await expect(body).not.toHaveAttribute("data-hide", /./)
    await expect.poll(() => toolRows().count()).toBeGreaterThan(0)
    expect(errors).toEqual([])
  })

  test("account switch and compaction markers in the 2,000-message session", async ({ page }) => {
    await openHarness(page)
    const body = await openSession(page, "ses_perf")
    const counts = await page.evaluate(() =>
      (window as unknown as { __transcript: { counts(): Record<string, number> } }).__transcript.counts(),
    )
    expect(counts.ses_perf).toBe(2_000)
    // Only visible rows are mounted (R2).
    expect(await body.locator("[data-timeline-key]").count()).toBeLessThan(40)
    const box = (await body.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    // Up until the marker is mounted, then onto the screen. Not `scrollIntoViewIfNeeded`: it waits for the row to stand
    // still for two frames, and right after a climb the window's rows are still being measured (the ResizeObserver
    // loop lines), so the marker kept moving and the wait ran out (1 run in 4 at the 2.2.6-own.13 tier). The marker is
    // scrolled to once more if a measurement moved it away.
    const reach = async (id: string) => {
      for (let index = 0; index < 400 && !(await body.getByTestId(id).count()); index++) await page.mouse.wheel(0, -600)
      await expect
        .poll(async () => {
          const marker = body.getByTestId(id).first()
          await marker.evaluate((element) => element.scrollIntoView({ block: "center" })).catch(() => undefined)
          return marker.isVisible()
        })
        .toBe(true)
    }
    await reach("switch-marker")
    const change = body.getByTestId("switch-marker").first()
    await expect(change).toContainText("계정 전환")
    await expect(change).toContainText(/개인 Pro|회사 · prod/)
    await expect(change.getByTestId("switch-rewrite")).toContainText(/캐시 재작성 \d+k/)
    await expect(change.getByTestId("switch-rewrite")).toContainText("실측")
    await reach("compaction-marker")
    const compaction = body.getByTestId("compaction-marker").first()
    await expect(compaction.getByTestId("compaction-sizes")).toContainText(/문맥 압축 · \d+k → \d+k/)
    await expect(compaction).toContainText("에서 요약")
    await compaction.getByRole("button", { name: "요약 보기" }).click()
    await expect(compaction).toContainText("지금까지의 대화를 요약했습니다")
  })

  test("streaming follows the tail; after scrolling up the viewport does not move (PF4)", async ({ page }) => {
    await openHarness(page)
    const body = await openSession(page, "ses_small")
    await expect(body.getByTestId("turn-footer").last()).toBeVisible()
    await page.evaluate(() =>
      (window as unknown as Harness).__transcript.stream({ sessionID: "ses_small", deltas: 300, perSecond: 200 }),
    )
    await expect(body.getByText("스트리밍 299")).toBeVisible()
    const pinned = await geometry(page, "ses_small")
    expect(pinned.max - pinned.top).toBeLessThanOrEqual(1)
    // The finished reply is announced once in the hidden log region (03 §11).
    await expect(body.getByTestId("transcript-announcer")).toContainText("개인 Pro 응답 완료")

    const box = (await body.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -900)
    await expect.poll(async () => (await geometry(page, "ses_small")).top).toBeLessThan(pinned.top - 500)
    const anchor = (await geometry(page, "ses_small")).top
    await page.evaluate(() =>
      (window as unknown as Harness).__transcript.stream({ sessionID: "ses_small", deltas: 300, perSecond: 200 }),
    )
    const after = await geometry(page, "ses_small")
    expect(Math.abs(after.top - anchor)).toBeLessThanOrEqual(1)
    expect(after.max).toBeGreaterThan(pinned.max)
    await body.getByRole("button", { name: "최신 메시지로" }).click()
    await expect
      .poll(async () => {
        const current = await geometry(page, "ses_small")
        return current.max - current.top
      })
      .toBeLessThanOrEqual(1)
  })

  test("a streamed answer ends exactly as a one-shot render, without word spans (PF4 incremental markdown)", async ({
    page,
  }) => {
    await openHarness(page)
    const body = await openSession(page, "ses_small")
    await expect(body.getByTestId("turn-footer").last()).toBeVisible()
    // Code blocks (shiki in the worker), nested and loose lists, tables, Korean prose, inline HTML comments.
    const text = [CORPUS.lists, CORPUS.tables, CORPUS.code, BENCH.slice(0, 4_000)].join("\n\n")
    const spans: number[] = []
    const sample = setInterval(() => {
      void body
        .evaluate((element) => element.querySelectorAll("[data-markdown-word]").length)
        .then((count) => spans.push(count))
        .catch(() => undefined)
    }, 100)
    await page.evaluate(
      (input) =>
        (window as unknown as Harness).__transcript.stream({ sessionID: "ses_small", perSecond: 150, ...input }),
      { text, chunk: 11 },
    )
    clearInterval(sample)
    const streamed = body.locator('[data-component="markdown"]').last()
    await expect(streamed).not.toHaveAttribute("data-streaming", "")
    await expect(streamed).toHaveAttribute("data-markdown-ready", "")
    await page.evaluate((value) => (window as unknown as Harness).__transcript.once(value), text)
    const once = page.locator('[data-testid="harness-once"] [data-component="markdown"]')
    await expect(once).toHaveAttribute("data-markdown-ready", "")
    // Block wrappers are display: contents bookkeeping; copy buttons and favicon load marks are not markdown.
    const content = (element: Element) => {
      const copy = element.cloneNode(true) as Element
      copy.querySelectorAll('[data-slot="markdown-copy-button"]').forEach((button) => button.replaceChildren())
      copy.querySelectorAll("[data-loaded]").forEach((node) => node.removeAttribute("data-loaded"))
      return Array.from(copy.children)
        .map((block) => block.innerHTML)
        .join("")
    }
    const final = await streamed.evaluate(content)
    expect(final).toContain('<code class="language-ts">')
    expect(final).toBe(await once.evaluate(content))
    expect(await streamed.evaluate((element) => element.querySelectorAll("[data-markdown-word]").length)).toBe(0)
    // While streaming only the newest text of the live block had a fade span (upstream: one span per word).
    expect(Math.max(0, ...spans)).toBeLessThan(40)
  })

  test("showing links, a remote picture and a video poster asks no other host (decisions TLM)", async ({ page }) => {
    await openHarness(page)
    const outside: string[] = []
    page.on("request", (request) => {
      const url = new URL(request.url())
      if (/^(https?|wss?):$/.test(url.protocol) && !/^(127\.|localhost$|\[::1\]$)/.test(url.hostname))
        outside.push(request.url())
    })
    const text = [
      "Docs: [OpenCode](https://opencode.ai/docs), [Example](https://example.org/guide), [repo](https://github.com/x/y).",
      "",
      "![diagram](https://example.net/diagram.png?d=secret)",
      "",
      '<video controls poster="https://example.net/poster.jpg"></video>',
    ].join("\n")
    await page.evaluate((value) => (window as unknown as Harness).__transcript.once(value), text)
    const once = page.locator('[data-testid="harness-once"] [data-component="markdown"]')
    await expect(once).toHaveAttribute("data-markdown-ready", "")
    await expect(once.locator('a[href="https://example.net/diagram.png?d=secret"]')).toHaveText("diagram")
    await expect(once.locator('img[src^="http"], img[src^="//"]')).toHaveCount(0)
    await expect(once.locator("video[poster]")).toHaveCount(0)
    // Three links and the picture's link, each with the stylesheet's mark and no image.
    await expect(once.locator(".markdown-link-favicon")).toHaveCount(4)
    await expect(once.locator(".markdown-link-favicon img")).toHaveCount(0)
    await page.waitForTimeout(1_000)
    expect(outside).toEqual([])
  })

  test("older pages load while scrolling up (30 first, then 20 per page)", async ({ page }) => {
    await openHarness(page, "?limit=30")
    const body = await openSession(page, "ses_paged")
    await expect(body.getByText("40번째 요청")).toBeVisible()
    await expect(body.getByText("1번째 요청", { exact: false }).first()).toHaveCount(0)
    const box = (await body.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await expect(async () => {
      await page.mouse.wheel(0, -3_000)
      await expect(body.getByText(/^1번째 요청/)).toBeVisible({ timeout: 500 })
    }).toPass({ timeout: 30_000 })
  })

  test("압축 내용 보기 (UC 2026-10-18): every compaction in order, the marker's open; summary, native, stand-in", async ({
    page,
  }) => {
    const errors = watchErrors(page)
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
    await openHarness(page)
    const body = await openSession(page, "ses_compact")
    const marker = body.getByTestId("compaction-marker").last()
    await marker.scrollIntoViewIfNeeded()
    await expect(marker.getByTestId("compaction-open-view")).toHaveText("압축 내용 보기")
    await marker.getByTestId("compaction-open-view").click()
    const dialog = page.getByTestId("compactions-dialog")
    await expect(dialog).toContainText("모델은 마지막 압축부터 그 앞의 메시지 대신 압축한 내용을 받아요.")
    const entries = dialog.getByTestId("compaction-entry")
    await expect(entries).toHaveCount(3)
    const [first, native, last] = [entries.nth(0), entries.nth(1), entries.nth(2)]

    // The marker's compaction is open and is the current one; a stand-in wrote it after the main's failed.
    await expect(last).toContainText("3번째 압축")
    await expect(last.getByTestId("compaction-current")).toHaveText("지금 모델이 받는 내용")
    await expect(last).toContainText("회사 · prod에서 대체 요약 · gpt-5.5")
    await expect(last.getByTestId("compaction-summary")).toHaveText("## 목표\n\n전환 비용 추정을 마무리한다.")
    // No step after it yet: the context after is measured at the next step, as on the marker.
    await expect(last.getByTestId("compaction-facts")).toHaveText(
      /^문맥 \d+k → 다음 단계에서 측정 · 압축 요청: 입력 \d+k · 출력 2k · 캐시 0%$/,
    )
    await last.getByTestId("compaction-copy").click()
    await expect(page.getByTestId("toasts")).toContainText("복사했어요")
    // The Windows clipboard hands line ends back as CRLF.
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied.replaceAll("\r\n", "\n")).toBe("## 목표\n\n전환 비용 추정을 마무리한다.")

    // own's checkpoint: closed until asked; the user's messages put back and the recent messages kept. own made it
    // while the user was away, from the whole conversation read from the cache (CC 2026-10-24).
    await expect(first).toContainText("다음 압축에 합쳐짐")
    await expect(first.getByTestId("compaction-idle")).toHaveText("자리를 비운 사이 압축했어요")
    await expect(first.getByTestId("compaction-facts")).toHaveText(
      /^문맥 \d+k → \d+k · 압축 요청: 입력 100k · 출력 2k · 캐시 99% · 대화 전체로 요청해 캐시를 이어 씀$/,
    )
    await expect(first.getByTestId("compaction-summary")).toHaveCount(0)
    await first.getByTestId("compaction-toggle").click()
    await expect(first.getByTestId("compaction-summary")).toContainText("계정 라우터의 전환 비용 추정을 확인한다.")
    await expect(first.getByTestId("compaction-user-messages")).toContainText("다시 넣는 내 메시지 2개")
    await expect(first.getByTestId("compaction-recent")).toContainText("그대로 남긴 최근 대화(")

    // Provider-native: encrypted, so only the model that made it and the size.
    await expect(native).toHaveAttribute("data-kind", "native")
    await expect(native.getByTestId("compaction-native")).toContainText("암호화해 두었어요")
    await expect(native.getByTestId("compaction-native")).toContainText("GPT-5.5 · 암호화된 항목 1개 · 2,400자")
    await expect(native.getByTestId("compaction-toggle")).toHaveCount(0)

    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    // The marker of the idle compaction (the first, further up) says why it ran.
    const idle = body.getByTestId("compaction-reason").filter({ hasText: "자리를 비운 사이 압축했어요" })
    await body.hover()
    for (let index = 0; index < 100 && !(await idle.count()); index++) await page.mouse.wheel(0, -600)
    await expect(idle).toHaveCount(1)
    expect(errors).toEqual([])
  })

  // Merge round 7: the compaction marker still put a `·` before each part of a wrapping pill, so a 375 px second line
  // started with one, and a wrapped switch marker's pill kept the whole width the wrap took (about 250 px of it empty
  // at 1440 px). Both are seps lines now (styles/seps.css), and a wrapped pill ends at its widest line.
  test("markers wrap on seps lines: no line starts with ·, and a wrapped pill ends at its widest line", async ({
    page,
  }) => {
    const errors = watchErrors(page)
    await openHarness(page)
    let wrapped = 0
    for (const width of [375, 520, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      for (const [sessionID, testid] of [
        ["ses_compact", "compaction-marker"],
        ["ses_switch", "switch-marker"],
      ] as const) {
        const body = await openSession(page, sessionID)
        const markers = body.getByTestId(testid)
        await expect(markers.first()).toBeVisible()
        for (const marker of await markers.all()) {
          const where = `${sessionID} at ${width} px`
          await expect.poll(() => sepsLines(marker), { message: where }).toMatchObject({ seps: true, dotted: [] })
          // The fit runs a frame after a resize.
          await expect.poll(async () => (await sepsLines(marker)).blank, { message: where }).toBeLessThanOrEqual(2)
          if ((await sepsLines(marker)).lines > 1) wrapped++
        }
      }
    }
    // The narrow widths did wrap, or this checked nothing.
    expect(wrapped).toBeGreaterThan(0)
    expect(errors).toEqual([])
  })

  // SL 2026-10-26: switching AC-03 → AC-01 → AC-02 between turns showed AC-01 (the first account on `anthropic`) on
  // every footer, though the ledger named each step's account.
  test("Claude accounts on one provider: each turn names the account that signed it (SL)", async ({ page }) => {
    const errors = watchErrors(page)
    await openHarness(page)
    const body = await openSession(page, "ses_claude")
    const footers = body.getByTestId("turn-footer")
    await expect(footers).toHaveCount(4)
    const account = (index: number) => footers.nth(index).locator('[data-slot="account"]')
    await expect(account(0)).toHaveText("AC-03")
    await expect(account(1)).toHaveText("AC-01")
    await expect(account(2)).toHaveText("AC-02")
    // The last step's: the auto switch moved the turn's second step to AC-03.
    await expect(account(3)).toHaveText("AC-03")
    await expect(footers.nth(1)).toContainText("Claude Haiku 5.5")
    await expect(footers.nth(1)).toContainText(/입력 \d+k \(캐시 0%\)/)
    // A switched-to account's cache is empty: the tag says so. A cold first step on the same account (after the
    // compaction) and the conversation's first step keep the plain tag.
    const tag = (index: number) => footers.nth(index).getByTestId("footer-rewrite")
    await expect(tag(0)).toHaveText("첫 단계 캐시 재작성")
    await expect(tag(1)).toHaveText("계정이 바뀌어서 캐시가 비었어요")
    await expect(tag(1)).toHaveAttribute("title", /앞 단계는 AC-03, 이 턴의 첫 단계는 AC-01에서 실행됐어요/)
    await expect(tag(2)).toHaveText("계정이 바뀌어서 캐시가 비었어요")
    await expect(tag(3)).toHaveText("첫 단계 캐시 재작성")
    await expect(tag(3)).not.toHaveAttribute("data-cause", "account")
    // The step table names each step's account only when the turn's steps ran on more than one. By turn (the user
    // message's id): the virtualizer may unmount the first footers once a table opens.
    const turn = (id: string) => body.locator(`[data-testid="turn-footer"][data-turn-id="msg_claude_${id}"]`)
    await turn("000004").getByRole("button").first().click()
    await expect(turn("000004").getByTestId("step-table").locator("tbody tr")).toHaveCount(1)
    await expect(turn("000004").locator('[data-slot="step-account"]')).toHaveCount(0)
    await turn("000007").getByRole("button").first().click()
    await expect(turn("000007").locator('[data-slot="step-account"]')).toHaveText(["AC-02", "AC-03"])
    // The compaction AC-02 signed, on its marker and in the viewer.
    const marker = body.getByTestId("compaction-marker")
    await expect(marker).toContainText("AC-02에서 요약")
    await marker.getByTestId("compaction-open-view").click()
    const dialog = page.getByTestId("compactions-dialog")
    await expect(dialog.getByTestId("compaction-entry")).toHaveCount(1)
    await expect(dialog.getByTestId("compaction-entry")).toContainText("AC-02에서 요약")
    await page.keyboard.press("Escape")
    expect(errors).toEqual([])
  })

  // SL-8: the switch marker and its screen-reader line named the provider's first Claude account (AC-01) on both sides.
  test("switch markers name the Claude accounts that signed the steps around them (SL-8)", async ({ page }) => {
    const errors = watchErrors(page)
    await openHarness(page)
    const body = await openSession(page, "ses_switch")
    const markers = body.getByTestId("switch-marker")
    await expect(markers).toHaveCount(1)
    await expect(markers.first()).toContainText("계정 전환")
    await expect(markers.first()).toContainText("AC-03 → 개인 Pro")
    // Back to Claude, live: the first step has not run, so the conversation's bound Claude account (AC-03) is the
    // other side, on the marker and in the hidden log line.
    await page.evaluate(() =>
      (window as unknown as Harness).__transcript.selectModel({
        sessionID: "ses_switch",
        model: { providerID: "anthropic", id: "claude-haiku-5-5" },
        previous: { providerID: "own-codex-a1b2", id: "gpt-5.6-sol", variant: "high" },
      }),
    )
    await expect(markers).toHaveCount(2)
    await expect(markers.nth(1)).toContainText("개인 Pro → AC-03")
    await expect(body.getByTestId("transcript-announcer")).toContainText("계정 전환: 개인 Pro → AC-03")

    // A Claude model switch on AC-02 keeps the account; the next one also moved the tree to AC-03.
    const model = await openSession(page, "ses_switch_model")
    const switches = model.getByTestId("switch-marker")
    await expect(switches).toHaveCount(2)
    await expect(switches.first()).toContainText("모델 전환")
    await expect(switches.first()).toContainText("AC-02Claude Haiku 5.5 → Claude Sonnet 5.5")
    await expect(switches.first()).not.toContainText("AC-01")
    await expect(switches.nth(1)).toContainText("계정 전환")
    await expect(switches.nth(1)).toContainText("AC-02 → AC-03")
    expect(errors).toEqual([])
  })

  // SL-8: the child's role line named the provider's first Claude account (AC-01).
  test("a Claude subagent's role line names the account that signed its step (SL-8)", async ({ page }) => {
    const errors = watchErrors(page)
    await openHarness(page)
    await openSession(page, "ses_claude_child")
    const role = page.getByTestId("child-notice").getByTestId("child-role")
    await expect(role).toContainText("AC-02")
    await expect(role).toContainText("Claude Haiku 5.5")
    await expect(role).not.toContainText("AC-01")
    expect(errors).toEqual([])
  })

  // SL-17: pending switches named the provider's first Claude account (AC-01): the composer's chip and the landing
  // toast read the provider without the session, and a ChatGPT conversation's switch to Claude named AC-01 everywhere
  // (its binding names the ChatGPT account until the switch lands; the switcher had moved its tree to AC-03).
  test("pending switches name the Claude account they land on (SL-17)", async ({ page }) => {
    const errors = watchErrors(page)
    await openHarness(page)
    const harness = (input: { sessionID: string; detail: Record<string, unknown> }) =>
      page.evaluate((value) => (window as unknown as Harness).__transcript.switchState(value), input)
    const landed = (sessionID: string, from: unknown, to: unknown, strategy: string) =>
      page.evaluate(
        (value) => (window as unknown as Harness).__transcript.recordSwitch({ ...value, created: Date.now() }),
        { sessionID, from, to, strategy },
      )
    const CODEX = { providerID: "own-codex-a1b2", id: "gpt-5.6-sol", variant: "high" }
    const HAIKU = { providerID: "anthropic", id: "claude-haiku-5-5" }
    const SONNET = { providerID: "anthropic", id: "claude-sonnet-5-5" }
    const CL03 = "acc_01M57GR3FAKE"
    const chip = page.getByTestId("pending-switch")
    const next = page.getByTestId("running-on-next")
    const deadline = Date.now() + 3_600_000

    // A AC-03 conversation scheduled away to ChatGPT: a message sent now still runs on AC-03.
    await openSession(page, "ses_pending_cl3")
    const cl3 = "ses_pending_cl3"
    const scheduled = { trigger: "either", idleMinutes: 60, uncertain: false, deadline }
    await harness({ sessionID: cl3, detail: { state: "SCHEDULED", target: CODEX, ...scheduled } })
    await expect(chip).toHaveAttribute("data-state", "SCHEDULED")
    await expect(chip).toContainText("개인 Pro로 전환")
    await expect(chip).toContainText("지금 보내면 AC-03으로 실행돼요")
    // A Claude model switch waits for the turn, then compacts first (records of a service before SL-17: no account).
    await harness({ sessionID: cl3, detail: { state: "WAIT_SAFE", target: SONNET, strategy: "now", reason: "manual" } })
    await expect(chip).toContainText("현재 턴이 끝나면: Claude Sonnet 5.5 @ AC-03")
    await expect(chip).toContainText("지금 보내면 현재 턴이 끝난 뒤 AC-03으로 실행돼요")
    await expect(next).toContainText("Claude Sonnet 5.5 @ AC-03")
    await harness({
      sessionID: cl3,
      detail: { state: "COMPACTING", target: SONNET, requestedAt: Date.now(), timeout: 600_000 },
    })
    await expect(chip).toContainText("압축 후 AC-03으로 전환하는 중")
    // It lands: the toast names AC-03.
    await harness({ sessionID: cl3, detail: { state: "STEADY" } })
    await landed(cl3, HAIKU, SONNET, "compact-then-switch")
    await expect(page.getByTestId("toast").filter({ hasText: "압축 직후 AC-03으로 전환했어요" })).toBeVisible()

    // ChatGPT → Claude: the record names AC-03, the account the switcher moved the tree to.
    await openSession(page, "ses_pending_gpt")
    const gpt = "ses_pending_gpt"
    await harness({
      sessionID: gpt,
      detail: { state: "WAIT_SAFE", target: HAIKU, strategy: "now", reason: "manual", accountID: CL03 },
    })
    await expect(chip).toContainText("현재 턴이 끝나면: Claude Haiku 5.5 @ AC-03")
    await expect(chip).toContainText("지금 보내면 현재 턴이 끝난 뒤 AC-03으로 실행돼요")
    await expect(next).toContainText("Claude Haiku 5.5 @ AC-03")
    await expect(page.getByTestId("running-on-pill")).toContainText("개인 Pro")
    await harness({ sessionID: gpt, detail: { state: "SCHEDULED", target: HAIKU, ...scheduled, accountID: CL03 } })
    await expect(chip).toContainText("AC-03으로 전환")
    await expect(chip).toContainText("지금 보내면 개인 Pro로 실행돼요")
    await expect(chip).not.toContainText("AC-01")
    // It lands (SWITCHING until core confirms): the toast names AC-03.
    await harness({
      sessionID: gpt,
      detail: { state: "SWITCHING", target: HAIKU, issuedAt: Date.now(), accountID: CL03 },
    })
    await landed(gpt, CODEX, HAIKU, "cold-point")
    await expect(page.getByTestId("toast").filter({ hasText: "캐시가 식어 AC-03으로 전환했어요" })).toBeVisible()
    await expect(page.getByTestId("toast").filter({ hasText: "AC-01" })).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test("child session: breadcrumb to the parent (18.11)", async ({ page }) => {
    await openHarness(page)
    await openSession(page, "ses_child")
    // The breadcrumb takes the header title slot (shell/header.tsx mounts `SessionTitle`).
    const crumb = page.getByTestId("header-title").getByTestId("child-breadcrumb")
    await expect(crumb).toContainText("짧은 세션")
    await expect(crumb).toContainText("› 하위 에이전트 explore")
    await crumb.getByRole("button", { name: "짧은 세션" }).click()
    await expect
      .poll(() => page.evaluate(() => (window as unknown as Harness).__transcript.route().sessionID))
      .toBe("ses_small")
  })

  test("a long transcript shows a 300-message window: up to the first turn, back down, 최신 메시지로 while streaming", async ({
    page,
  }) => {
    const errors = watchErrors(page)
    await openHarness(page)
    const body = await openSession(page, "ses_perf")
    await expect(body.getByText(/^400번째 요청/)).toBeVisible()
    /** The highest `N번째 요청` mounted. */
    const newest = () =>
      body.evaluate((element) =>
        Math.max(
          0,
          ...[...element.querySelectorAll('[data-timeline-row="UserMessage"]')].map((row) =>
            Number(/(\d+)번째 요청/.exec(row.textContent ?? "")?.[1] ?? 0),
          ),
        ),
      )
    test.setTimeout(240_000)
    const box = (await body.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    // All 2,000 messages are loaded; the view projects the newest 300 and moves its window up at the top, no request.
    // Wheel steps of 2,000 px: a 15,000 px step lands far above the measured rows, and measuring them moved the view
    // back onto the same rows (stuck at turn ~274 in 3 of 4 runs here, 2 of 4 in the review).
    await expect(async () => {
      await page.mouse.wheel(0, -2_000)
      await expect(body.getByText(/^1번째 요청/)).toBeVisible({ timeout: 200 })
    }).toPass({ timeout: 150_000, intervals: [0] })
    expect(await body.locator("[data-timeline-key]").count()).toBeLessThan(60)
    // Back down: the window follows toward the tail (turn 120 lies past the first window of about 60 turns).
    await expect(async () => {
      await page.mouse.wheel(0, 15_000)
      expect(await newest()).toBeGreaterThan(120)
    }).toPass({ timeout: 60_000, intervals: [0] })
    // An earlier window always offers 최신 메시지로; it returns to the tail while a turn streams there.
    await page.evaluate(() => {
      void (window as unknown as Harness).__transcript.stream({ sessionID: "ses_perf", deltas: 400, perSecond: 100 })
    })
    await body.getByRole("button", { name: "최신 메시지로" }).click()
    await expect(body.getByText(/^스트리밍 \d+/).first()).toBeVisible()
    // Every 40th delta is a paragraph break: the last words are `스트리밍 398`.
    await expect(body.getByText("스트리밍 398")).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(async () => {
        const current = await geometry(page, "ses_perf")
        return current.max - current.top
      })
      .toBeLessThanOrEqual(1)
    expect(errors).toEqual([])
  })

  test("a long transcript read 30 at a time: up to the first turn holding a bounded part, back down, 최신 메시지로", async ({
    page,
  }) => {
    const errors = watchErrors(page)
    await openHarness(page, "?limit=30")
    const body = await openSession(page, "ses_perf")
    await expect(body.getByText(/^400번째 요청/)).toBeVisible()
    test.setTimeout(240_000)
    const harness = () =>
      page.evaluate(() => {
        const transcript = (window as unknown as Harness).__transcript
        return { pages: transcript.pages(), store: transcript.loaded("ses_perf") }
      })
    const turns = () =>
      body.evaluate((element) =>
        [...element.querySelectorAll('[data-timeline-row="UserMessage"]')].map((row) =>
          Number(/(\d+)번째 요청/.exec(row.textContent ?? "")?.[1] ?? 0),
        ),
      )
    const box = (await body.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    // Up through all 2,000 messages, 20 per read: the view's own pages; the store keeps its newest messages only.
    await expect(async () => {
      await page.mouse.wheel(0, -15_000)
      await expect(body.getByText(/^1번째 요청/)).toBeVisible({ timeout: 200 })
    }).toPass({ timeout: 150_000, intervals: [0] })
    const top = await harness()
    expect(top.pages).toBeGreaterThan(90)
    expect(top.store).toBeLessThanOrEqual(90)
    expect(await body.locator("[data-timeline-key]").count()).toBeLessThan(60)
    // Back down: the dropped pages are read again, in order, until they meet the store's messages.
    await expect(async () => {
      await page.mouse.wheel(0, 15_000)
      expect(Math.max(0, ...(await turns()))).toBeGreaterThan(395)
    }).toPass({ timeout: 150_000, intervals: [0] })
    expect((await harness()).pages).toBeGreaterThan(top.pages + 50)
    // Every turn on screen follows the one before it: nothing missing or doubled where pages meet.
    const shown = (await turns()).filter((turn) => turn > 0)
    expect(shown).toEqual(shown.map((_, index) => shown[0]! + index))
    // Halfway up again, then 최신 메시지로 while a turn streams at the tail.
    await expect(async () => {
      await page.mouse.wheel(0, -15_000)
      expect(Math.min(...(await turns()))).toBeLessThan(200)
    }).toPass({ timeout: 90_000, intervals: [0] })
    await page.evaluate(() => {
      void (window as unknown as Harness).__transcript.stream({ sessionID: "ses_perf", deltas: 400, perSecond: 100 })
    })
    await body.getByRole("button", { name: "최신 메시지로" }).click()
    await expect(body.getByText("스트리밍 398")).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(async () => {
        const current = await geometry(page, "ses_perf")
        return current.max - current.top
      })
      .toBeLessThanOrEqual(1)
    expect(errors).toEqual([])
  })

  test("a revert committed at a turn only the view's pages hold keeps the turns before it", async ({ page }) => {
    const errors = watchErrors(page)
    await openHarness(page, "?limit=30")
    const body = await openSession(page, "ses_perf")
    await expect(body.getByText(/^400번째 요청/)).toBeVisible()
    const turns = () =>
      body.evaluate((element) =>
        [...element.querySelectorAll('[data-timeline-row="UserMessage"]')].map((row) =>
          Number(/(\d+)번째 요청/.exec(row.textContent ?? "")?.[1] ?? 0),
        ),
      )
    const box = (await body.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    // A few pages up: turn 385 is in the view's own pages (the store holds the newest 30 messages, turns 395 on).
    await expect(async () => {
      await page.mouse.wheel(0, -3_000)
      expect(Math.min(...(await turns()))).toBeLessThan(380)
    }).toPass({ timeout: 60_000, intervals: [0] })
    await page.evaluate(() => (window as unknown as Harness).__transcript.commitRevert("ses_perf", "385번째 요청:"))
    // The store's list is empty now; the pages end at turn 384 and stay on screen, down to their end.
    await expect.poll(async () => (await turns()).filter((turn) => turn > 0).length).toBeGreaterThan(0)
    expect(Math.max(...(await turns()))).toBeLessThan(385)
    await expect(async () => {
      await page.mouse.wheel(0, 5_000)
      expect(Math.max(...(await turns()))).toBe(384)
    }).toPass({ timeout: 30_000, intervals: [100] })
    await expect(body.getByText(/^38[5-9]번째 요청|^39\d번째 요청|^400번째 요청/)).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test("switching back re-attaches the cached session view (PF7)", async ({ page }) => {
    await openHarness(page)
    const small = await openSession(page, "ses_small")
    await expect(small.getByTestId("turn-footer").last()).toBeVisible()
    await small.evaluate((element) => element.setAttribute("data-probe", "kept"))
    await openSession(page, "ses_mark")
    await expect(page.locator('[data-testid="transcript-body"][data-session-id="ses_small"]')).toHaveCount(0)
    const again = await openSession(page, "ses_small")
    await expect(again).toHaveAttribute("data-probe", "kept")
    await expect(again.getByTestId("turn-footer").last()).toBeVisible()
  })
})

test.describe("transcript on the real server", () => {
  test("prompt → footer from the ledger; compaction and account switch markers", async ({ page, request }) => {
    test.setTimeout(180_000)
    const state = backend()
    const session = state.sessions[2]!
    const rpc = async (method: string, input: unknown, directory: string) => {
      const response = await request.post(`/api/rpc/own.accounts/${method}`, {
        params: { "location[directory]": directory },
        data: { input },
      })
      const body = (await response.json()) as { output?: Record<string, unknown> }
      expect(response.ok(), `${method}: ${JSON.stringify(body)}`).toBe(true)
      return body.output ?? {}
    }
    const idle = () =>
      expect
        .poll(
          async () =>
            // The route answers `{data: {[sessionID]: status}}`.
            ((await (await request.get("/api/session/active")).json()) as { data: Record<string, unknown> }).data[
              session.id
            ],
          {
            timeout: 60_000,
          },
        )
        .toBeUndefined()
    const prompt = async (text: string) => {
      const response = await request.post(`/api/session/${session.id}/prompt`, { data: { text } })
      expect(response.ok()).toBe(true)
    }

    await page.goto(`/srv/local/s/${session.id}`)
    const body = page.locator(`[data-testid="transcript-body"][data-session-id="${session.id}"]`)
    await expect(body).toBeVisible()
    await prompt("전환 비용 추정을 보여 주세요")
    await expect(body.getByText("전환 비용 추정을 보여 주세요")).toBeVisible()
    await idle()
    const footer = body.getByTestId("turn-footer").last()
    await expect(footer).toContainText(state.account.label)
    await expect(footer).toContainText(new RegExp(state.model.replaceAll(".", "\."), "i"))
    await expect(footer).toContainText(/입력 \d/)
    await expect(footer).toContainText(/\$\d|비용 알 수 없음/)

    // The fake provider does not write a template summary, so core fails the compaction: a failed or running
    // compaction stays session-ui's row (the own marker is for completed ones, covered by the fixture tests).
    const compact = await request.post(`/api/session/${session.id}/compact`, { data: {} })
    expect(compact.ok()).toBe(true)
    await expect(body.getByText("세션 압축 실패")).toBeVisible({ timeout: 60_000 })
    await expect(body.getByTestId("compaction-marker")).toHaveCount(0)
    await idle()

    // A second API-key account, then a switch through the router: the marker is drawn, the model never sees it.
    const added = (await rpc(
      "accounts.add.key",
      { kind: "oai", label: "Beta", key: "sk-proj-ownWebE2eFakeKey0000000000000002" },
      state.control,
    )) as { account: { id: string; providerID: string } }
    const target = { providerID: added.account.providerID, id: state.model }
    try {
      await expect
        .poll(
          async () => {
            const response = await request.post(`/api/rpc/own.accounts/switch.apply`, {
              params: { "location[directory]": state.workspace },
              data: { input: { sessionID: session.id, target, strategy: "now", reason: "manual" } },
            })
            return response.ok()
          },
          { timeout: 30_000 },
        )
        .toBe(true)
      const marker = body.getByTestId("switch-marker").last()
      await expect(marker).toContainText("계정 전환", { timeout: 30_000 })
      await expect(marker).toContainText("Beta")
      // This window saw the router's switch.recorded, so the marker names the method.
      await expect(marker).toContainText("지금 전환")
      await expect(marker).toContainText("화면 전용")
      await prompt("이어서 계속")
      await idle()
      await expect(marker.getByTestId("switch-rewrite")).toContainText("실측")
      // Nothing about the switch reached the conversation as a message the model reads.
      const messages = (await (
        await request.get(`/api/session/${session.id}/message`, { params: { limit: 200 } })
      ).json()) as {
        data: { type: string; text?: string }[]
      }
      expect(
        messages.data.filter((item) => item.type !== "assistant" && /계정 전환|화면 전용|Beta/.test(item.text ?? "")),
      ).toEqual([])
    } finally {
      await request.post(`/api/rpc/own.accounts/switch.apply`, {
        params: { "location[directory]": state.workspace },
        data: {
          input: {
            sessionID: session.id,
            target: { providerID: state.account.providerID, id: state.model },
            strategy: "now",
            reason: "manual",
          },
        },
      })
      const plan = (await rpc(
        "accounts.remove.plan",
        { accountID: added.account.id, mode: "delete" },
        state.control,
      )) as {
        nonce: string
      }
      await rpc("accounts.remove.execute", { nonce: plan.nonce }, state.control)
    }
  })
})

// 이미지 만들기 on a phone (02 §9.6, MUX 2026-11-06): the made image opens whole, the accounts tried first are folded,
// a long saved path wraps instead of widening the line.
test.describe("image result on a phone", () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true })

  test("the image opens whole and closes; 먼저 시도한 계정 is folded; nothing scrolls sideways", async ({ page }) => {
    await openHarness(page)
    const body = await openSession(page, "ses_image")
    const line = body.getByTestId("image-line")
    await line.scrollIntoViewIfNeeded()
    await expect(line).toHaveAttribute("data-status", "done")
    await expect(line.locator(".own-img-steps")).not.toHaveAttribute("open", "")
    await expect(line.locator(".own-img-steps summary")).toHaveText("먼저 시도한 계정 (1)")
    const width = await page.evaluate(() => document.documentElement.clientWidth)
    expect((await line.boundingBox())!.width).toBeLessThanOrEqual(width)
    await line.getByTestId("image-line-open").tap()
    const view = page.getByTestId("image-line-view")
    await expect(view).toBeVisible()
    // The store keeps no tool file bytes (as in the app): the card read its picture from the whole message, once. It
    // shows as a blob: URL: Chromium keeps every data: URI an image loaded for as long as the page lives.
    await expect(view.locator("img")).toHaveAttribute("src", /^blob:/)
    await expect.poll(() => view.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(2)
    expect(
      await page.evaluate(() => (window as unknown as { __transcript: { reads(): string[] } }).__transcript.reads()),
    ).toHaveLength(1)
    const image = (await view.locator("img").boundingBox())!
    expect(image.width).toBeGreaterThan(width / 2)
    await view.getByTestId("image-line-close").tap()
    await expect(view).toBeHidden()
    // The user's pasted picture: a blob: URL that loads.
    const attachment = body.locator('[data-slot="user-message-attachment-image"]')
    await attachment.scrollIntoViewIfNeeded()
    await expect(attachment).toHaveAttribute("src", /^blob:/)
    await expect.poll(() => attachment.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(2)
    // The Android app's back button sends Escape (src/host/app-bridge.ts); a synthetic one closes it too.
    await line.getByTestId("image-line-open").tap()
    await view.evaluate((dialog) =>
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })),
    )
    await expect(view).toBeHidden()
  })
})

// 이미지 만들기 in GIF and SVG (decisions IM-23): the GIF card shows the whole loop from `preview` (not the first-frame
// file part), the SVG card shows the SVG as an `<img>` only, so its script and `onload` never run and no `<svg>` element
// reaches the page; each line names the format, the SVG line its authoring tokens.
test.describe("image formats", () => {
  test("an animated GIF and an SVG are drawn as images, the SVG's script never runs", async ({ page }) => {
    await openHarness(page)
    const body = await openSession(page, "ses_image_formats")
    const lines = body.getByTestId("image-line")
    await expect(lines).toHaveCount(2)
    const gif = lines.nth(0)
    await gif.scrollIntoViewIfNeeded()
    await expect(gif.getByTestId("image-line-format")).toHaveText("GIF 애니메이션 · 2프레임 · 프레임 크기 960x960 (요청한 1024x1024보다 줄였어요)")
    const gifImage = gif.locator("img[data-format='gif']").first()
    await expect(gifImage).toHaveAttribute("src", /^blob:/)
    await expect.poll(() => gifImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1)
    const svg = lines.nth(1)
    await svg.scrollIntoViewIfNeeded()
    await expect(svg.getByTestId("image-line-format")).toHaveText("SVG (벡터)")
    await expect(svg).toContainText("SVG 작성 gpt-6-luna: 입력 1200 · 출력 800 토큰 · $0.0005 (위 비용에 들어 있어요)")
    const svgImage = svg.locator("img[data-format='svg']").first()
    await expect(svgImage).toHaveAttribute("src", /^blob:/)
    await expect.poll(() => svgImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(64)
    expect(await page.locator("[data-testid='image-line'] svg").count()).toBe(0)
    expect(await page.evaluate(() => (window as unknown as { __svgRan?: number }).__svgRan)).toBeUndefined()
    // The larger view is an <img> too.
    await svg.getByTestId("image-line-open").click()
    await expect(page.getByTestId("image-line-view").locator("img[data-format='svg']").first()).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { __svgRan?: number }).__svgRan)).toBeUndefined()
  })
})
