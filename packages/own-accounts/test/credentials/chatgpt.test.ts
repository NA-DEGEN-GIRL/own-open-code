// ChatGPT device-code and browser PKCE logins against the fake OAuth issuer and fake Codex backend, and the
// token-endpoint refresher. Fake tokens only; the manual clock drives polling and expiry.

import { afterAll, describe, expect, test } from "bun:test"
import type { OwnID } from "@own/protocol"
import { startFakeChatGPTAuth, startFakeCodex } from "../e2e-kit"
import { call, codexRequest, harness, sharedClock, statuses, until, type Harness } from "./support.js"

const time = sharedClock()
const codex = startFakeCodex({ clock: time.clock })
const auth = startFakeChatGPTAuth({ codex })

afterAll(async () => {
  await Promise.all([auth.stop(), codex.stop()])
})

const endpoints = { oauthIssuer: auth.url, codex: codex.baseURL }
const NADIA = { accountID: "acct-nadia", email: "nadia@example.test", plan: "pro", userID: "user-nadia" }

async function login(h: Harness) {
  time.follow(h.clock)
  const started = await call(h.logins.chatgptStart, { method: "device" })
  if (!started.ok || started.output.method !== "device") throw new Error("start failed")
  return started.output
}

/** Fires the next device poll and waits until it answered and the next poll (if any) is scheduled. */
async function poll(h: Harness) {
  const before = auth.requests.filter((request) => request.path === "/api/accounts/deviceauth/token").length
  const timers = h.clock.pending()
  h.clock.advance(4_000)
  await until(() =>
    auth.requests.filter((request) => request.path === "/api/accounts/deviceauth/token").length > before
      ? true
      : undefined,
  )
  await until(async () => {
    const status = await call(h.logins.chatgptStatus, { attemptID: attemptOf(h) })
    return (status.ok && status.output.phase !== "pending") || h.clock.pending() >= timers ? true : undefined
  })
}

const attempts = new WeakMap<Harness, OwnID.AttemptID>()
function attemptOf(h: Harness) {
  const id = attempts.get(h)
  if (!id) throw new Error("no attempt")
  return id
}

async function status(h: Harness, attemptID: string) {
  const result = await call(h.logins.chatgptStatus, { attemptID: attemptID as never })
  if (!result.ok) throw new Error("status failed")
  return result.output
}

async function authorizedLogin(h: Harness, account: typeof NADIA) {
  const started = await login(h)
  attempts.set(h, started.attemptID)
  auth.approve(started.userCode, account)
  await poll(h)
  await until(async () => ((await status(h, started.attemptID)).phase === "authorized" ? true : undefined))
  return started
}

describe("ChatGPT device login", () => {
  test("polls while pending, then complete stores the tokens and creates a working codex account", async () => {
    await using h = await harness({ options: { endpoints } })
    const started = await login(h)
    attempts.set(h, started.attemptID)
    expect(started.verificationURL).toBe(`${auth.url}/codex/device`)
    expect(started.userCode).toBe(auth.userCodes.at(-1) ?? "")
    expect(JSON.parse(auth.requests.at(-1)?.body ?? "{}").client_id).toBe("app_EMoamEEZ73f0CkXaXp7hrann")

    await poll(h)
    expect(await status(h, started.attemptID)).toEqual({ phase: "pending" })

    auth.approve(started.userCode, NADIA)
    await poll(h)
    await until(async () => ((await status(h, started.attemptID)).phase === "authorized" ? true : undefined))
    expect(await status(h, started.attemptID)).toEqual({
      phase: "authorized",
      identity: { emailMasked: "na***@example.test", plan: "pro" },
    })
    // Nothing is stored before `complete`.
    const before = await h.deps.runtime.vault.list()
    expect(before.ok && before.ids).toEqual([])

    const completed = await call(h.logins.chatgptComplete, { attemptID: started.attemptID, label: "개인" })
    if (!completed.ok) throw new Error(`complete failed: ${completed.type} ${completed.message}`)
    expect(completed.output).toMatchObject({
      reauthenticated: false,
      account: {
        kind: "codex",
        label: "개인",
        status: "ready",
        billing: "subscription",
        // The login method is stored on the account (Account.Info.method) so the UI can label it.
        connection: { type: "oauth", method: "chatgpt-device" },
        identity: { emailMasked: "na***@example.test", plan: "pro" },
      },
    })
    const account = h.modules.slots.account(completed.output.account.id)
    if (!account) throw new Error("no account")
    expect(account.identity.chatgptAccountId).toBe("acct-nadia")
    expect(account.method).toBe("chatgpt-device")
    expect(account.identity.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(await h.deps.runtime.credentials.inspect(account)).toMatchObject({ ok: true, type: "oauth", generation: 1 })

    const headers = await h.logins.headers(account, "ses_1")
    if (!headers.ok) throw new Error(`headers failed: ${headers.problem}`)
    expect(headers.headers).toMatchObject({
      "chatgpt-account-id": "acct-nadia",
      "session-id": "ses_1",
      originator: "opencode",
    })
    expect(await codexRequest(codex.baseURL, headers.headers)).toBe(200)

    const phases = statuses(h.events).map((event) => event.phase)
    expect(phases).toEqual(["awaiting_user", "authorized", "completed"])
    // A second complete of the same attempt is refused.
    const again = await call(h.logins.chatgptComplete, { attemptID: started.attemptID })
    expect(again).toMatchObject({ ok: false, type: "internal_error", message: "attempt_completed" })

    const exposed = JSON.stringify([h.events, completed.output, await status(h, started.attemptID)]) + h.logs.join("\n")
    const access = headers.headers.authorization?.replace("Bearer ", "") ?? "missing"
    expect(exposed).not.toContain(access)
  })

  test("logging in again as the same user re-authenticates the existing account", async () => {
    await using h = await harness({ options: { endpoints } })
    const first = await authorizedLogin(h, NADIA)
    const created = await call(h.logins.chatgptComplete, { attemptID: first.attemptID })
    if (!created.ok) throw new Error("first complete failed")

    const second = await authorizedLogin(h, NADIA)
    expect(await status(h, second.attemptID)).toMatchObject({
      phase: "authorized",
      duplicateOf: created.output.account.id,
    })
    const again = await call(h.logins.chatgptComplete, { attemptID: second.attemptID })
    expect(again).toMatchObject({
      ok: true,
      output: { reauthenticated: true, account: { id: created.output.account.id } },
    })
    expect(h.modules.slots.snapshot().accounts).toHaveLength(1)
    const account = h.modules.slots.account(created.output.account.id)
    expect(account && (await h.deps.runtime.credentials.inspect(account))).toMatchObject({ generation: 2 })
  })

  test("re-authentication as another ChatGPT user is refused by the account guard", async () => {
    await using h = await harness({ options: { endpoints } })
    const first = await authorizedLogin(h, NADIA)
    const created = await call(h.logins.chatgptComplete, { attemptID: first.attemptID })
    if (!created.ok) throw new Error("complete failed")

    time.follow(h.clock)
    const reauth = await call(h.logins.chatgptStart, { method: "device", accountID: created.output.account.id })
    if (!reauth.ok || reauth.output.method !== "device") throw new Error("start failed")
    attempts.set(h, reauth.output.attemptID)
    auth.approve(reauth.output.userCode, { ...NADIA, accountID: "acct-other", userID: "user-other" })
    await poll(h)
    await until(async () => ((await status(h, reauth.output.attemptID)).phase === "failed" ? true : undefined))
    expect(await status(h, reauth.output.attemptID)).toEqual({ phase: "failed", error: "account_mismatch" })
    const refused = await call(h.logins.chatgptComplete, { attemptID: reauth.output.attemptID })
    expect(refused).toMatchObject({ ok: false, type: "internal_error", message: "attempt_failed" })
    expect(h.modules.slots.snapshot().accounts).toHaveLength(1)

    const unknown = await call(h.logins.chatgptStart, { method: "device", accountID: "acc_nope" as never })
    expect(unknown).toMatchObject({ ok: false, type: "account_not_found" })
  })

  test("cancel stops the attempt; an unanswered code expires", async () => {
    await using h = await harness({ options: { endpoints } })
    const started = await login(h)
    attempts.set(h, started.attemptID)
    expect(await call(h.logins.chatgptCancel, { attemptID: started.attemptID })).toEqual({ ok: true, output: {} })
    expect(await status(h, started.attemptID)).toEqual({ phase: "cancelled" })
    const polls = auth.requests.filter((request) => request.path === "/api/accounts/deviceauth/token").length
    auth.approve(started.userCode, NADIA)
    h.clock.advance(8_000)
    await Bun.sleep(50)
    expect(auth.requests.filter((request) => request.path === "/api/accounts/deviceauth/token")).toHaveLength(polls)

    const late = await login(h)
    attempts.set(h, late.attemptID)
    h.clock.advance(15 * 60_000)
    await until(async () => ((await status(h, late.attemptID)).phase === "failed" ? true : undefined))
    expect(await status(h, late.attemptID)).toEqual({ phase: "failed", error: "expired" })
    expect(await status(h, "att_unknown")).toEqual({ phase: "failed", error: "attempt_not_found" })
  })
})

describe("ChatGPT browser login", () => {
  test("PKCE callback on the local server authorizes the attempt", async () => {
    await using h = await harness({ options: { endpoints } })
    time.follow(h.clock)
    const started = await call(h.logins.chatgptStart, { method: "browser" })
    if (!started.ok || started.output.method !== "browser") throw new Error("start failed")
    const url = new URL(started.output.authorizeURL)
    expect(url.origin + url.pathname).toBe(`${auth.url}/oauth/authorize`)
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/auth\/callback$/)
    expect(url.searchParams.get("originator")).toBe("opencode")

    const forged = new URL(url.searchParams.get("redirect_uri") ?? "")
    forged.searchParams.set("code", "ac_forged")
    forged.searchParams.set("state", "wrong")
    expect((await fetch(forged)).status).toBe(400)

    const callback = auth.authorize(started.output.authorizeURL, NADIA)
    const page = await fetch(callback)
    expect(page.status).toBe(200)
    expect(await status(h, started.output.attemptID)).toMatchObject({ phase: "authorized" })
    const completed = await call(h.logins.chatgptComplete, { attemptID: started.output.attemptID })
    expect(completed).toMatchObject({
      ok: true,
      output: { reauthenticated: false, account: { connection: { type: "oauth", method: "chatgpt-browser" } } },
    })
  })
})

describe("refresher", () => {
  test("a due token is refreshed once through the token endpoint and stored before it is used", async () => {
    await using h = await harness({ options: { endpoints } })
    const started = await authorizedLogin(h, NADIA)
    const completed = await call(h.logins.chatgptComplete, { attemptID: started.attemptID })
    if (!completed.ok) throw new Error("complete failed")
    const account = h.modules.slots.account(completed.output.account.id)
    if (!account) throw new Error("no account")
    const first = await h.logins.headers(account, "ses_1")
    if (!first.ok) throw new Error("headers failed")

    // Inside the 5-minute refresh window (02 §3.5 F1); concurrent requests share one refresh (F2).
    h.clock.advance(56 * 60_000)
    const results = await Promise.all(Array.from({ length: 5 }, () => h.logins.headers(account, "ses_1")))
    expect(codex.refreshCount("acct-nadia")).toBe(1)
    const tokenCalls = auth.requests.filter((request) => request.path === "/oauth/token")
    expect(tokenCalls.at(-1)?.body).toContain("grant_type=refresh_token")
    expect(new Set(results.map((result) => (result.ok ? result.hash : "failed")))).toEqual(
      new Set([results[0]?.ok ? results[0].hash : "x"]),
    )
    const next = results[0]
    if (!next?.ok) throw new Error("refresh failed")
    expect(next.hash).not.toBe(first.hash)
    expect(await h.deps.runtime.credentials.inspect(account)).toMatchObject({ generation: 2 })
    expect(await codexRequest(codex.baseURL, next.headers)).toBe(200)
    // The replaced access token was only superseded, the linked-style 401 path is not involved.
    expect(h.modules.slots.account(account.id)?.status).toBe("ready")
  })
})
