// 문맥 비우기 (03 §18.18, 11 §7, core P-035) in the real app against the real server (e2e/backend.ts, fake provider):
// /reset-context → the marker and its toast, the turns before it dimmed and the model's context without them → a
// prompt on the fresh context → 되돌리기 → the earlier messages are back in the context → another prompt. A reset
// during a turn waits in the queue dock (cancellable), `/compact` behind it admits nothing, a follow-up sent meanwhile
// queues behind it, stopping the turn applies it at once without a model turn of its own, and `중단하고 지금 비우기`
// applies it and runs what was sent after it. A reset while idle applies at once, ahead of a prompt a stop left parked
// (the toast says so truthfully). A compaction another client admits before or behind a waiting reset is settled as
// not needed when it applies, with a toast naming the session. The `⋯` item,
// folding the earlier turns into the marker, and after a compaction the marker's `이 지점 전으로 포크`. At 375 px
// nothing scrolls sideways.
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test"
import { backend, sepsLines, useSendKey, watchErrors } from "./support"

const state = backend()

type Message = { readonly id: string; readonly type: string; readonly text?: string; readonly reason?: string }

async function newSession(request: APIRequestContext, title: string) {
  const response = await request.post("/api/session", {
    data: {
      title,
      model: { providerID: state.account.providerID, id: state.model },
      location: { directory: state.workspace },
    },
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { data: { id: string } }).data.id
}

/** What the model gets now (`GET /api/session/:id/context`). */
async function context(request: APIRequestContext, sessionID: string) {
  return ((await (await request.get(`/api/session/${sessionID}/context`)).json()) as { data: Message[] }).data
}

const users = (messages: readonly Message[]) =>
  messages.flatMap((message) => (message.type === "user" ? [message.text] : []))

const active = async (request: APIRequestContext, sessionID: string) =>
  ((await (await request.get("/api/session/active")).json()) as { data: Record<string, unknown> }).data[sessionID] !==
  undefined

type Listed = { readonly type: string; readonly text?: string; readonly time: { readonly completed?: number } }

/** Until `text` was answered (a completed step after it) and the session is idle again. */
async function answered(request: APIRequestContext, sessionID: string, text: string) {
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/session/${sessionID}/message?limit=50&order=desc`)
        const listed = ((await response.json()) as { data: Listed[] }).data
        const index = listed.findIndex((message) => message.type === "user" && message.text === text)
        const replied = listed
          .slice(0, Math.max(0, index))
          .some((message) => message.type === "assistant" && message.time.completed !== undefined)
        return index > 0 && replied && !(await active(request, sessionID))
      },
      { timeout: 60_000 },
    )
    .toBe(true)
}

/** Until the session is idle after work that runs no model step of its own (a compaction, for one). */
async function idle(request: APIRequestContext, sessionID: string) {
  await request.post(`/api/experimental/session/${sessionID}/wait`)
  await expect.poll(() => active(request, sessionID), { timeout: 60_000 }).toBe(false)
}

async function open(page: Page, sessionID: string) {
  await page.goto(`/srv/local/s/${sessionID}`)
  const body = page.locator(`[data-testid="transcript-body"][data-session-id="${sessionID}"]`)
  await expect(body).toBeVisible({ timeout: 60_000 })
  return body
}

/** Types into the composer and sends with Enter; a slash command closes the suggestion list first. */
async function send(page: Page, text: string) {
  const input = page.locator("#own-composer-input")
  await input.fill(text)
  if (text.startsWith("/")) await input.press("Escape")
  await input.press("Enter")
  await expect(input).toHaveValue("")
}

async function ask(page: Page, request: APIRequestContext, sessionID: string, body: Locator, text: string) {
  await send(page, text)
  await expect(body.getByText(text)).toBeVisible()
  await answered(request, sessionID, text)
}

test.describe.configure({ mode: "serial" })

test.beforeEach(async ({ page }) => {
  await useSendKey(page, "enter")
})

test("/reset-context → marker → send → undo → send", async ({ page, request }) => {
  test.setTimeout(180_000)
  const errors = watchErrors(page)
  const sessionID = await newSession(request, "문맥 비우기 e2e")
  const body = await open(page, sessionID)
  await ask(page, request, sessionID, body, "첫 질문이에요")

  await send(page, "/reset-context")
  await expect(page.getByText("문맥을 비웠어요 · 대화 부분은 캐시를 처음부터 다시 써요")).toBeVisible()
  const marker = body.getByTestId("reset-marker")
  await expect(marker).toHaveAttribute("data-state", "active")
  await expect(marker).toContainText("여기부터 새 문맥")
  await expect(marker).toHaveAttribute("role", "separator")
  await expect(body.locator(".own-row[data-before-reset]").first()).toBeVisible()
  const fresh = await context(request, sessionID)
  expect(fresh[0]).toMatchObject({ type: "compaction", reason: "reset" })
  expect(users(fresh)).toEqual([])

  await ask(page, request, sessionID, body, "두 번째 질문이에요")
  expect(users(await context(request, sessionID))).toEqual(["두 번째 질문이에요"])

  await marker.getByTestId("reset-undo").click()
  await expect(page.getByText("문맥을 되돌렸어요 · 앞 대화를 다시 보내요")).toBeVisible()
  await expect(marker).toHaveAttribute("data-state", "undone")
  await expect(marker).toContainText("문맥 비우기를 되돌렸어요")
  await expect(body.locator(".own-row[data-before-reset]")).toHaveCount(0)
  expect(users(await context(request, sessionID))).toEqual(["첫 질문이에요", "두 번째 질문이에요"])

  await ask(page, request, sessionID, body, "세 번째 질문이에요")
  expect(users(await context(request, sessionID))).toEqual([
    "첫 질문이에요",
    "두 번째 질문이에요",
    "세 번째 질문이에요",
  ])
  expect(errors.filter((error) => !/Failed to load resource|net::/.test(error))).toEqual([])
})

test("a reset during a turn waits in the queue dock, can be cancelled, and a follow-up queues behind it", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  const sessionID = await newSession(request, "문맥 비우기 e2e 대기")
  const body = await open(page, sessionID)
  await ask(page, request, sessionID, body, "앞의 질문이에요")
  await send(page, "[slow 8000] 오래 걸리는 질문이에요")
  await expect.poll(() => active(request, sessionID)).toBe(true)

  await send(page, "/reset-context")
  await expect(page.getByText("이 턴이 끝나면 문맥을 비워요")).toBeVisible()
  const row = page.locator('[data-testid="queue-row"][data-control="reset"]')
  await expect(row).toContainText("문맥 비우기 · 이 턴이 끝나면")
  await row.getByTestId("queue-reset-cancel").click()
  await expect(row).toHaveCount(0)
  await expect
    .poll(
      async () => ((await (await request.get(`/api/session/${sessionID}/inbox`)).json()) as { data: unknown[] }).data,
    )
    .toEqual([])

  await send(page, "/reset-context")
  await expect(row).toBeVisible()
  // The reset empties what a compaction would summarize: nothing is admitted, and the toast offers to cancel it.
  await send(page, "/compact")
  await expect(page.getByText("문맥 비우기가 기다리고 있어서 압축하지 않아요")).toBeVisible()
  expect(
    ((await (await request.get(`/api/session/${sessionID}/inbox`)).json()) as { data: { type: string }[] }).data.map(
      (item) => item.type,
    ),
  ).toEqual(["reset"])
  // Sent while the reset waits: it queues behind it, so it starts the fresh context.
  await send(page, "비운 뒤의 질문이에요")
  await answered(request, sessionID, "비운 뒤의 질문이에요")
  await expect(body.getByTestId("reset-marker")).toHaveAttribute("data-state", "active")
  await expect(row).toHaveCount(0)
  expect(users(await context(request, sessionID))).toEqual(["비운 뒤의 질문이에요"])
})

test("cancelling a waiting reset steers into the running turn what was queued only because of it", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  const sessionID = await newSession(request, "문맥 비우기 e2e 취소")
  const body = await open(page, sessionID)
  await ask(page, request, sessionID, body, "취소 전 질문이에요")
  await send(page, "[slow 12000] 길게 도는 질문이에요")
  await expect.poll(() => active(request, sessionID)).toBe(true)
  await send(page, "/reset-context")
  const row = page.locator('[data-testid="queue-row"][data-control="reset"]')
  await expect(row).toBeVisible()
  // Enter would steer without the reset; the other-delivery key queues on purpose.
  await send(page, "비우기 때문에 기다린 질문이에요")
  const input = page.locator("#own-composer-input")
  await input.fill("일부러 대기열에 둔 질문이에요")
  await input.press("Control+Enter")
  await expect(input).toHaveValue("")
  type Pending = { type: string; delivery: string; payload: { text?: string; metadata?: Record<string, unknown> } }
  const pending = async () =>
    ((await (await request.get(`/api/session/${sessionID}/inbox`)).json()) as { data: Pending[] }).data.map((item) => [
      item.type,
      item.delivery,
      item.payload.text ?? null,
      item.payload.metadata?.["own.resetHeld"] ?? null,
    ])
  await expect.poll(pending).toEqual([
    ["reset", "queue", null, null],
    ["user", "queue", "비우기 때문에 기다린 질문이에요", true],
    ["user", "queue", "일부러 대기열에 둔 질문이에요", null],
  ])

  // The queue dock's `✕`: the message the reset held steers into the running turn, as without the reset.
  await row.getByTestId("queue-reset-cancel").click()
  await expect(row).toHaveCount(0)
  await expect.poll(pending, { timeout: 8_000 }).toEqual([
    ["user", "steer", "비우기 때문에 기다린 질문이에요", true],
    ["user", "queue", "일부러 대기열에 둔 질문이에요", null],
  ])
  expect(await active(request, sessionID)).toBe(true)
  await answered(request, sessionID, "일부러 대기열에 둔 질문이에요")
  await expect(body.getByTestId("reset-marker")).toHaveCount(0)
  expect(users(await context(request, sessionID))).toEqual([
    "취소 전 질문이에요",
    "[slow 12000] 길게 도는 질문이에요",
    "비우기 때문에 기다린 질문이에요",
    "일부러 대기열에 둔 질문이에요",
  ])
})

test("stopping the turn applies a waiting reset at once; the next message starts the fresh context", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  const sessionID = await newSession(request, "문맥 비우기 e2e 중단")
  const body = await open(page, sessionID)
  await ask(page, request, sessionID, body, "멈추기 전 질문이에요")
  await send(page, "[slow 20000] 멈출 질문이에요")
  await expect.poll(() => active(request, sessionID)).toBe(true)
  await send(page, "/reset-context")
  const row = page.locator('[data-testid="queue-row"][data-control="reset"]')
  await expect(row).toBeVisible()

  // The stopped turn has ended, so core delivers the reset right away; it needs no model call and starts no turn.
  await page.getByTestId("composer-stop").click()
  await expect(page.getByTestId("composer-stop")).toBeHidden({ timeout: 30_000 })
  await expect(row).toHaveCount(0)
  await expect(body.getByTestId("reset-marker")).toHaveAttribute("data-state", "active")
  expect(await active(request, sessionID)).toBe(false)
  expect(users(await context(request, sessionID))).toEqual([])

  await ask(page, request, sessionID, body, "멈춘 뒤의 질문이에요")
  expect(users(await context(request, sessionID))).toEqual(["멈춘 뒤의 질문이에요"])
})

test("중단하고 지금 비우기 applies the reset now and runs what was sent after it in the fresh context", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  const sessionID = await newSession(request, "문맥 비우기 e2e 지금")
  const body = await open(page, sessionID)
  await ask(page, request, sessionID, body, "지금 비우기 전 질문이에요")
  await send(page, "[slow 20000] 끊길 질문이에요")
  await expect.poll(() => active(request, sessionID)).toBe(true)
  await send(page, "/reset-context")
  const now = page.getByRole("button", { name: "중단하고 지금 비우기" })
  await expect(now).toBeVisible()
  await send(page, "비우자마자 돌 질문이에요")
  await now.click()
  await answered(request, sessionID, "비우자마자 돌 질문이에요")
  await expect(body.getByTestId("reset-marker")).toHaveAttribute("data-state", "active")
  expect(users(await context(request, sessionID))).toEqual(["비우자마자 돌 질문이에요"])
})

test("a stop applies a waiting reset ahead of a steer and a compaction sent before it; the compaction is settled", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  const sessionID = await newSession(request, "문맥 비우기 e2e 앞선 입력")
  const body = await open(page, sessionID)
  await ask(page, request, sessionID, body, "앞선 입력 전 질문이에요")
  await send(page, "[slow 20000] 멈출 질문이에요")
  await expect.poll(() => active(request, sessionID)).toBe(true)
  // Another client steers a message and asks for a compaction while the turn runs, before the reset.
  expect(
    (await request.post(`/api/session/${sessionID}/prompt`, { data: { text: "끼워 넣은 질문이에요" } })).ok(),
  ).toBe(true)
  expect((await request.post(`/api/session/${sessionID}/compact`, { data: {} })).ok()).toBe(true)
  await send(page, "/reset-context")
  await expect(page.locator('[data-testid="queue-row"][data-control="reset"]')).toBeVisible()

  await page.getByTestId("composer-stop").click()
  await expect(page.getByTestId("composer-stop")).toBeHidden({ timeout: 30_000 })
  // The compaction would have summarized the emptied context: it is settled as not needed, not failed. The toast names
  // the session, since it comes for any session this window tracks.
  await expect(page.getByText("문맥 비우기 e2e 앞선 입력 — 문맥을 비워서 기다리던 압축은 하지 않았어요")).toBeVisible()
  await expect(page.getByTestId("compaction-failed")).toHaveCount(0)
  await expect(body.getByTestId("reset-marker")).toHaveAttribute("data-state", "active")
  const inbox = (
    (await (await request.get(`/api/session/${sessionID}/inbox`)).json()) as {
      data: { type: string; delivery: string; payload: { text?: string } }[]
    }
  ).data
  expect(inbox.map((item) => [item.type, item.delivery, item.payload.text])).toEqual([
    ["user", "steer", "끼워 넣은 질문이에요"],
  ])
  // The steer sent before the reset waits in the fresh context, like after a reset right after the stop.
  await ask(page, request, sessionID, body, "멈춘 뒤 다음 질문이에요")
  expect(users(await context(request, sessionID))).toEqual(["끼워 넣은 질문이에요", "멈춘 뒤 다음 질문이에요"])
})

test("a compaction another client asks for behind a waiting reset is settled when the turn ends", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  const sessionID = await newSession(request, "문맥 비우기 e2e 뒤 압축")
  const body = await open(page, sessionID)
  await ask(page, request, sessionID, body, "뒤 압축 전 질문이에요")
  await send(page, "[slow 6000] 끝날 질문이에요")
  await expect.poll(() => active(request, sessionID)).toBe(true)
  await send(page, "/reset-context")
  await expect(page.locator('[data-testid="queue-row"][data-control="reset"]')).toBeVisible()
  // The TUI's `/compact`, or own.accounts' compact-then-switch, while the reset waits.
  expect((await request.post(`/api/session/${sessionID}/compact`, { data: {} })).ok()).toBe(true)
  await expect(page.getByText("문맥 비우기 e2e 뒤 압축 — 문맥을 비워서 기다리던 압축은 하지 않았어요")).toBeVisible({
    timeout: 30_000,
  })
  await idle(request, sessionID)
  await expect(page.getByTestId("compaction-failed")).toHaveCount(0)
  await expect(body.getByTestId("reset-marker")).toHaveAttribute("data-state", "active")
  expect(((await (await request.get(`/api/session/${sessionID}/inbox`)).json()) as { data: unknown[] }).data).toEqual(
    [],
  )
})

test("the waiting toast closes when the turn ends and the reset applies on its own", async ({ page, request }) => {
  test.setTimeout(180_000)
  const sessionID = await newSession(request, "문맥 비우기 e2e 토스트")
  const body = await open(page, sessionID)
  await ask(page, request, sessionID, body, "토스트 전 질문이에요")
  await send(page, "[slow 4000] 곧 끝날 질문이에요")
  await expect.poll(() => active(request, sessionID)).toBe(true)
  await send(page, "/reset-context")
  const now = page.getByRole("button", { name: "중단하고 지금 비우기" })
  await expect(now).toBeVisible()
  await answered(request, sessionID, "[slow 4000] 곧 끝날 질문이에요")
  await expect(body.getByTestId("reset-marker")).toHaveAttribute("data-state", "active")
  // Its action would now stop a turn of the fresh context, so it goes with the reset.
  await expect(now).toBeHidden({ timeout: 5_000 })
})

test("a reset while idle applies at once, ahead of a prompt a stop left parked", async ({ page, request }) => {
  test.setTimeout(180_000)
  const sessionID = await newSession(request, "문맥 비우기 e2e 멈춰 둔 질문")
  const body = await open(page, sessionID)
  await ask(page, request, sessionID, body, "쉬기 전 질문이에요")
  await send(page, "[slow 20000] 멈출 긴 질문이에요")
  await expect.poll(() => active(request, sessionID)).toBe(true)
  const parked = await request.post(`/api/session/${sessionID}/prompt`, {
    data: { text: "멈춰 둔 질문이에요", delivery: "queue" },
  })
  expect(parked.ok()).toBe(true)
  await page.getByTestId("composer-stop").click()
  await expect(page.getByTestId("composer-stop")).toBeHidden({ timeout: 30_000 })
  await idle(request, sessionID)

  await send(page, "/reset-context")
  await expect(page.getByText("문맥을 비웠어요 · 대화 부분은 캐시를 처음부터 다시 써요")).toBeVisible()
  await expect(body.getByTestId("reset-marker")).toHaveAttribute("data-state", "active")
  // No model turn: the parked prompt stays parked, now for the fresh context.
  expect(await active(request, sessionID)).toBe(false)
  expect(users(await context(request, sessionID))).toEqual([])
  const inbox = (
    (await (await request.get(`/api/session/${sessionID}/inbox`)).json()) as {
      data: { type: string; payload: { text?: string } }[]
    }
  ).data
  expect(inbox.map((item) => item.payload.text)).toEqual(["멈춰 둔 질문이에요"])
})

test("the ⋯ item, folding the earlier turns, and after a compaction the marker forks from before it", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  const sessionID = await newSession(request, "문맥 비우기 e2e 포크")
  const body = await open(page, sessionID)
  await ask(page, request, sessionID, body, "접힐 질문이에요")
  await page.getByTestId("session-menu").first().click()
  await page.getByTestId("session-menu-reset").click()
  const marker = body.getByTestId("reset-marker")
  await expect(marker).toHaveAttribute("data-state", "active")
  // `[summary ok]`: the fake writes a template summary for this conversation (e2e/backend.ts).
  await ask(page, request, sessionID, body, "남을 질문이에요 [summary ok]")

  await marker.getByTestId("reset-fold").click()
  await expect(marker.getByTestId("reset-folded")).toHaveText("이전 대화 1턴 · 모델은 보지 않아요")
  await expect(body.getByText("접힐 질문이에요")).toHaveCount(0)
  await marker.getByTestId("reset-unfold").click()
  await expect(body.getByText("접힐 질문이에요")).toBeVisible()

  const compacted = await request.post(`/api/session/${sessionID}/compact`, { data: {} })
  expect(compacted.ok()).toBe(true)
  await idle(request, sessionID)
  await expect(marker).toHaveAttribute("data-state", "blocked")
  await expect(marker.getByTestId("reset-undo")).toHaveCount(0)
  await expect(marker.getByTestId("reset-blocked")).toHaveText("그 뒤에 압축해서 되돌릴 수 없어요")
  await marker.getByTestId("reset-fork-before").click()
  await expect(page).not.toHaveURL(new RegExp(sessionID))
  const forked = /\/s\/([^/?#]+)/.exec(page.url())?.[1]
  expect(forked).toBeTruthy()
  expect(users(await context(request, forked!))).toEqual(["접힐 질문이에요"])
})

test("375 px: the marker fits without sideways scrolling and its buttons are 44 px tap targets", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 375, height: 812 })
  const sessionID = await newSession(request, "문맥 비우기 e2e 폰")
  const body = await open(page, sessionID)
  await ask(page, request, sessionID, body, "폰에서 묻는 질문이에요")
  await send(page, "/reset-context")
  const undo = body.getByTestId("reset-marker").getByTestId("reset-undo")
  await expect(undo).toBeVisible()
  expect((await undo.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  // Merge round 7: a seps line (styles/seps.css), so a wrapped line never starts with `·`, and the pill ends at its
  // widest line (transcript/seps-fit.ts).
  const marker = body.getByTestId("reset-marker")
  await expect.poll(() => sepsLines(marker)).toMatchObject({ seps: true, dotted: [] })
  await expect.poll(async () => (await sepsLines(marker)).blank).toBeLessThanOrEqual(2)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})
