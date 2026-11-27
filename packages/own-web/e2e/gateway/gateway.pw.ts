// M1 remote access in Edge (05 §15 M1; gates MG1–MG6 and MG8 of 05 §14.3, on loopback). One PC tab (desktop) and phone
// tabs (375 px mobile emulation: touch, coarse pointer, a phone user agent) walk the whole flow in order:
// turn the gateway on from 설정 > 기기 (plan → execute), Tailscale detected only, pair a phone (QR link, SAS on both
// screens, 허용), the phone's app through /srv/local (list, a prompt, the scope matrix at the gateway), an SSH host's
// session through /srv/<hostId> (prompt, account switch), offline and back (service-worker shell, cached list, draft,
// no auto-send, the feed), revoke (streams closed within 5 s, the other phone unaffected), and a secret scan of
// everything the phones and OWN_HOME hold. Then 08 app access: AA (an Android app pairs natively over the pinned
// listener) and AA-M (모바일 미리보기: Pixel 7 as the app through the loopback link, approved on the PC, revoked).
// See backend.ts for the stack (fake provider and fake SSH host only).
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import https from "node:https"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { TLSSocket } from "node:tls"
import { devices, expect, test, type Browser, type BrowserContext, type Page, type Response } from "@playwright/test"
import { OwnAccounts } from "@own/protocol"
import { OwnRemote } from "@own/protocol/rpc-remote"
import { backend, deviceStorage, FAKE_KEYS, PHONE, providerRequests, serviceRequests, shotsDir, type GatewayBackendState } from "./support"

test.describe.configure({ mode: "serial" })

let state: GatewayBackendState
let pc: BrowserContext
let pcPage: Page
let gateway = ""
/** Every phone context of the run, for the secret scan. */
const phones: Array<{ context: BrowserContext; page: Page; bodies: string[] }> = []
let phone: (typeof phones)[number]
/** A second paired phone (MG3's admin phone): it must keep working when `phone` is revoked (MG4). */
let otherPhone: (typeof phones)[number]
let phoneDeviceId = ""
const results: Record<string, unknown> = {}

async function shot(target: Page, name: string) {
  fs.mkdirSync(shotsDir(), { recursive: true })
  await target.screenshot({ path: path.join(shotsDir(), `${name}.png`) })
}

async function rpc(method: string, input: unknown, id = OwnRemote.ID) {
  const response = await fetch(`${state.serverUrl}/api/rpc/${id}/${method}?location[directory]=${encodeURIComponent(state.control)}`, {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`opencode:${state.localPassword}`)}`, "content-type": "application/json" },
    body: JSON.stringify({ input }),
  })
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, any> }
}

async function newPhone(browser: Browser) {
  const context = await browser.newContext({ ...PHONE })
  const page = await context.newPage()
  const bodies: string[] = []
  const collect = async (response: Response) => {
    const type = response.headers()["content-type"] ?? ""
    if (/event-stream/.test(type)) return
    const body = await response.text().catch(() => "")
    bodies.push(`${response.url()}\n${JSON.stringify(response.headers())}\n${body}`)
  }
  page.on("response", (response) => void collect(response))
  const entry = { context, page, bodies }
  phones.push(entry)
  return entry
}

/** Pairs a phone through the UI: 새 기기 연결 → link → phone shows the SAS → PC dialog with the same SAS → 허용. */
async function pair(target: (typeof phones)[number], name: string, scopes?: readonly string[]) {
  await pcPage.goto("/settings/devices")
  const form = pcPage.getByTestId("pairing-new")
  await form.getByTestId("pairing-name").fill(name)
  if (scopes)
    for (const scope of OwnRemote.DEVICE_SCOPES) {
      const box = form.getByTestId(`pairing-scope-${scope}`).locator("input")
      if ((await box.isChecked()) !== scopes.includes(scope)) await box.click()
    }
  await form.getByTestId("pairing-create").click()
  await expect(form.getByTestId("pairing-qr")).toBeVisible()
  if (phones.length === 1) {
    await form.getByTestId("pairing-qr").scrollIntoViewIfNeeded()
    await shot(pcPage, "02b-pc-qr")
  }
  const url = (await form.getByTestId("pairing-url").textContent())!.trim()
  expect(url).toMatch(new RegExp(`^${gateway}/auth/connect/[A-Za-z0-9_-]{22}$`))
  await target.page.goto(url)
  await expect(target.page).toHaveURL(`${gateway}/pair`)
  const sas = (await target.page.getByTestId("device-sas").textContent({ timeout: 30_000 }))!.trim()
  const audit = await touchAudit(target.page)
  expect({ width: audit.width, panned: audit.panned, small: audit.small }).toEqual({ width: 375, panned: 0, small: [] })
  expect(sas).toMatch(/^\d{4}$/)
  const dialog = pcPage.getByTestId("pairing-approve")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId("pairing-sas")).toHaveText(sas)
  return { url, sas, dialog }
}

test.beforeAll(async ({ browser }) => {
  state = backend()
  gateway = `http://127.0.0.1:${state.gatewayPort}`
  pc = await browser.newContext({ locale: "ko-KR", viewport: { width: 1440, height: 900 } })
  pcPage = await pc.newPage()
})

test.afterAll(async () => {
  fs.mkdirSync(shotsDir(), { recursive: true })
  fs.writeFileSync(path.join(shotsDir(), "results.json"), JSON.stringify(results, null, 2))
  for (const entry of phones) await entry.context.close().catch(() => undefined)
  await pc?.close()
})

test("PC: 설정 > 기기 turns the gateway on (plan → execute); Tailscale is detected, never configured", async () => {
  await pcPage.goto("/settings/devices")
  await expect(pcPage.getByTestId("pairing-gateway-state")).toHaveAttribute("data-state", "off")
  const tailscale = pcPage.getByTestId("pairing-tailscale")
  await expect(tailscale).toHaveAttribute("data-state", "missing")
  await expect(tailscale).toContainText("Tailscale을 설치하거나 설정하지 않아요")
  await pcPage.getByTestId("pairing-port").fill(String(state.gatewayPort))
  await pcPage.getByTestId("pairing-enable").click()
  const plan = pcPage.getByTestId("pairing-plan")
  await expect(plan).toContainText(gateway)
  await shot(pcPage, "01-pc-gateway-plan")
  await plan.getByTestId("pairing-plan-confirm").click()
  await expect(pcPage.getByTestId("pairing-gateway-state")).toHaveAttribute("data-state", "listening")
  await expect(pcPage.getByTestId("pairing-gateway-state")).toContainText(gateway)
  // With a port, the guidance shows the serve command (copy only; own-open-code never runs it).
  await expect(pcPage.getByTestId("pairing-serve-command")).toHaveText(
    `tailscale serve --bg --https=443 http://127.0.0.1:${state.gatewayPort}`,
  )
  await shot(pcPage, "02-pc-gateway-on")
  const settings = JSON.parse(fs.readFileSync(path.join(state.ownHome, "gateway.json"), "utf8"))
  expect(settings).toMatchObject({ enabled: true, bind: "127.0.0.1", port: state.gatewayPort })
})

test("MG1: listeners on loopback only, no LAN address answers, LAN binds are bind_rejected_lan", async () => {
  const listening = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Get-NetTCPConnection -State Listen -OwningProcess ${state.serverPid} | ForEach-Object { "$($_.LocalAddress) $($_.LocalPort)" }`,
    ],
    { encoding: "utf8", windowsHide: true },
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  results.mg1Listeners = listening
  expect(listening.some((line) => line.endsWith(` ${state.gatewayPort}`))).toBe(true)
  for (const line of listening) expect(line).toMatch(/^(127\.\d+\.\d+\.\d+|::1) \d+$/)
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && !entry.internal && entry.family === "IPv4")
    .map((entry) => entry!.address)
  results.mg1LanAddresses = lan
  for (const address of lan) {
    const reached = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: address, port: state.gatewayPort })
      socket.once("connect", () => (socket.destroy(), resolve(true)))
      socket.once("error", () => resolve(false))
      socket.setTimeout(2000, () => (socket.destroy(), resolve(false)))
    })
    expect({ address, reached }).toEqual({ address, reached: false })
  }
  for (const bind of ["0.0.0.0", "::", "192.168.0.10", "10.0.0.2", "169.254.1.1", "100.100.100.100"]) {
    const result = await rpc("gateway.configure.plan", { bind, port: state.gatewayPort })
    expect({ bind, status: result.status, type: result.body.type }).toEqual({ bind, status: 400, type: "bind_rejected_lan" })
  }
})

test("MG2: pairing — the phone shows the SAS, the PC allows the same number, the phone lands in the app", async ({ browser }) => {
  phone = await newPhone(browser)
  const { url, dialog } = await pair(phone, "테스트 폰")
  await shot(phone.page, "03-phone-waiting-sas")
  await shot(pcPage, "04-pc-approve-sas")
  await dialog.getByTestId("pairing-allow").click()
  await expect(phone.page.getByTestId("session-list")).toContainText(state.localSession.title, { timeout: 60_000 })
  await expect(pcPage.getByTestId("pairing-status")).toContainText("테스트 폰", { timeout: 30_000 })
  const device = pcPage.locator('[data-testid="pairing-device"]').filter({ hasText: "테스트 폰" })
  await expect(device).toBeVisible()
  phoneDeviceId = (await device.getAttribute("data-device"))!
  expect(phoneDeviceId).toMatch(/^dev_/)
  await shot(phone.page, "05-phone-app-list")
  await shot(pcPage, "06-pc-device-list")
  const cookies = await phone.context.cookies()
  const deviceCookie = cookies.find((cookie) => cookie.name === "own_device")!
  expect(deviceCookie).toMatchObject({ httpOnly: true, sameSite: "Strict" })
  expect(cookies.some((cookie) => cookie.name === "own_pairing")).toBe(false)
  // The same link again: one use only.
  const reuse = await (await browser.newContext({ ...PHONE })).newPage()
  await reuse.goto(url)
  await expect(reuse.getByTestId("device-pairing")).toContainText("만료되었어요")
  await reuse.context().close()
})

test("MG2: PC 거부, SAS mismatch and a wrong code register nothing; guessing codes is rate limited", async ({ browser }) => {
  const before = (await rpc("devices.list", {})).body.output.devices.length
  const denied = await newPhone(browser)
  const { dialog } = await pair(denied, "거부할 폰")
  await dialog.getByTestId("pairing-deny").click()
  await expect(denied.page.getByTestId("device-pairing")).toHaveAttribute("data-state", "rejected", { timeout: 15_000 })
  await shot(denied.page, "07-phone-rejected")
  // SAS mismatch through the RPC (the UI always sends the number it shows).
  const started = (await rpc("devices.pair.start", { name: "불일치", scopes: ["read"], servers: { mode: "all" }, expiresDays: 7 })).body.output
  const context = await browser.newContext({ ...PHONE })
  const page = await context.newPage()
  await page.goto(started.url)
  const sas = (await page.getByTestId("device-sas").textContent())!.trim()
  const wrong = await rpc("devices.pair.approve", { pairingId: started.pairingId, sas: sas === "0000" ? "0001" : "0000" })
  expect(wrong).toMatchObject({ status: 400, body: { type: "pairing_rejected" } })
  await expect(page.getByTestId("device-pairing")).toHaveAttribute("data-state", "rejected", { timeout: 15_000 })
  await context.close()
  expect((await rpc("devices.list", {})).body.output.devices.length).toBe(before)
  // Brute force: bad codes from one address → 429 after five.
  const statuses: number[] = []
  for (let attempt = 0; attempt < 7; attempt++)
    statuses.push(
      (await fetch(`${gateway}/auth/connect/AAAAAAAAAAAAAAAAAAAAB${attempt}`, { headers: { accept: "application/json", "x-forwarded-for": "100.64.7.7" } })).status,
    )
  results.mg2BruteForce = statuses
  expect(statuses).toEqual([410, 410, 410, 410, 410, 429, 429])
})

/**
 * 03 §4.2 phone tier and 4.2.2 at 375 px: the page cannot pan sideways, and every visible control is at least 44×44
 * under a coarse pointer (hidden, inert and off-screen elements do not count; a field counts through its 44 px box).
 */
async function touchAudit(page: Page) {
  return page.evaluate(() => {
    window.scrollTo(2000, 0)
    const panned = window.scrollX
    window.scrollTo(0, 0)
    const small: string[] = []
    let controls = 0
    for (const element of document.querySelectorAll<HTMLElement>(".own-target, button, a[href], [role=button], input, select")) {
      if (element.closest("[inert]") || element.offsetParent === null || element.classList.contains("own-skip")) continue
      if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
      if (element.tagName === "INPUT" && (element as HTMLInputElement).type === "checkbox") continue
      if (element.tagName === "INPUT" && element.parentElement?.classList.contains("own-target")) continue
      const box = element.getBoundingClientRect()
      if (box.width === 0 || box.bottom <= 0 || box.right <= 0 || box.top >= innerHeight || box.left >= innerWidth) continue
      controls++
      if (box.width < 44 || box.height < 44)
        small.push(`${element.dataset.testid ?? element.getAttribute("aria-label") ?? (element.textContent ?? "").trim().slice(0, 16)} ${Math.round(box.width)}x${Math.round(box.height)}`)
    }
    return {
      width: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
      panned,
      controls,
      small,
    }
  })
}

test("phone at 375 px: no sideways scroll, 44 px touch targets, devices page hidden, a prompt answered", async () => {
  const page = phone.page
  const audits: Record<string, unknown> = {}
  const audit = async (name: string) => {
    const result = await touchAudit(page)
    audits[name] = result
    expect({ name, width: result.width, panned: result.panned, small: result.small }).toEqual({
      name,
      width: 375,
      panned: 0,
      small: [],
    })
    expect(result.controls).toBeGreaterThan(3)
  }
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true)
  await audit("list")
  await page.getByTestId("session-list").getByText(state.localSession.title).first().click()
  await expect(page).toHaveURL(new RegExp(`/s/${state.localSession.id}$`))
  const composer = page.locator("#own-composer-input")
  await expect(composer).toBeVisible()
  await expect(page.getByTestId("transcript").getByText("Alpha 계정으로 온 답").first()).toBeVisible({ timeout: 30_000 })
  await audit("session")
  await composer.fill("휴대폰에서 안녕")
  await composer.press("Control+Enter")
  await expect(page.getByTestId("transcript").getByText("휴대폰에서 안녕")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("transcript").getByText("Alpha 계정으로 온 답").nth(1)).toBeVisible({ timeout: 90_000 })
  await shot(page, "08-phone-session")
  // 설정 > 기기 is a PC page: the phone's settings list does not have it, and its RPCs are refused anyway.
  await page.goto(`${gateway}/settings`)
  await expect(page.getByTestId("page-settings")).toHaveAttribute("data-view", "list")
  await expect(page.locator('a[href="/settings/general"]')).toHaveCount(1)
  await expect(page.locator('a[href="/settings/devices"]')).toHaveCount(0)
  await audit("settings")
  // A page's header is one row on the phone (03 §4.2): back · title · bulb, cog and ?, each a 44 px target.
  const header = await page.getByTestId("header").evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    row: parseFloat(getComputedStyle(node).getPropertyValue("--own-header-h")),
  }))
  expect(header.height).toBeLessThanOrEqual(header.row + 1)
  await shot(page, "09-phone-settings")
  results.phone375 = audits
})

test("MG3: scope matrix at the gateway — out of scope and local are 403 and never reach the service", async ({ browser }) => {
  const readOnly = await newPhone(browser)
  const { dialog } = await pair(readOnly, "읽기 전용 폰", ["read"])
  await dialog.getByTestId("pairing-allow").click()
  await expect(readOnly.page.getByTestId("session-list")).toContainText(state.localSession.title, { timeout: 60_000 })
  const admin = await newPhone(browser)
  const second = await pair(admin, "관리 폰", ["read", "prompt", "switch", "admin"])
  await second.dialog.getByTestId("pairing-allow").click()
  await expect(admin.page.getByTestId("session-list")).toContainText(state.localSession.title, { timeout: 60_000 })
  otherPhone = admin
  const devices = {
    read: { entry: readOnly, scopes: new Set(["read"]) },
    phone: { entry: phone, scopes: new Set(["read", "prompt", "switch"]) },
    admin: { entry: admin, scopes: new Set(["read", "prompt", "switch", "admin"]) },
  }
  const query = `location[directory]=${encodeURIComponent(state.control)}`
  const mismatches: string[] = []
  let calls = 0
  for (const [label, { entry, scopes }] of Object.entries(devices)) {
    const call = async (id: string, method: string, input: unknown = {}) => {
      calls++
      const before = serviceRequests().length
      const response = await entry.page.request.post(`${gateway}/srv/local/api/rpc/${id}/${method}?${query}`, {
        data: { input },
        headers: { origin: gateway },
      })
      const reached = serviceRequests()
        .slice(before)
        .some((request) => request.path === `/api/rpc/${id}/${method}`)
      return { status: response.status(), reached }
    }
    for (const [method, scope] of Object.entries(OwnAccounts.MethodScope)) {
      const allowed = scope !== "local" && scopes.has(scope)
      const result = await call(OwnAccounts.ID, method)
      if ((result.status === 403) === allowed || result.reached !== allowed)
        mismatches.push(`${label} ${OwnAccounts.ID} ${method} ${JSON.stringify(result)}`)
    }
    for (const method of Object.keys(OwnRemote.MethodScope) as OwnRemote.MethodName[]) {
      const scope = OwnRemote.MethodScope[method]
      const needed = scope === "read" ? "read" : scope === "drive" ? "switch" : scope === "manage" ? "admin" : undefined
      const allowed = needed !== undefined && scopes.has(needed)
      const result = await call(OwnRemote.ID, method)
      if ((result.status === 403) === allowed || result.reached !== allowed)
        mismatches.push(`${label} ${OwnRemote.ID} ${method} ${JSON.stringify(result)}`)
    }
  }
  // Body rules and always-blocked paths with the widest device.
  const post = (route: string, body: unknown) =>
    admin.page.request.post(`${gateway}/srv/local${route}${route.includes("?") ? "&" : "?"}${query}`, { data: body, headers: { origin: gateway } })
  const checks: Array<[string, () => Promise<number>]> = [
    ["connect{hostKeyPrompt}", async () => (await post("/api/rpc/own.remote/connect", { input: { hostId: state.farHost, clientId: "x", hostKeyPrompt: true } })).status()],
    ["accounts.update{replaceKey}", async () => (await post("/api/rpc/own.accounts/accounts.update", { input: { accountID: "a", replaceKey: "sk-fake" } })).status()],
    ["permission always", async () => (await post(`/api/session/${state.localSession.id}/permission/per_x/reply`, { decision: "always" })).status()],
    ["/api/pair", async () => (await post("/api/pair", {})).status()],
    ["/api/integration", async () => (await admin.page.request.get(`${gateway}/srv/local/api/integration?${query}`)).status()],
    ["pty", async () => (await post("/api/pty", {})).status()],
    ["session.shell", async () => (await post(`/api/session/${state.localSession.id}/shell`, { command: "whoami" })).status()],
    ["fs.list", async () => (await admin.page.request.get(`${gateway}/srv/local/api/fs/list?${query}`)).status()],
  ]
  const before = serviceRequests().length
  for (const [label, run] of checks) {
    const status = await run()
    if (status !== 403) mismatches.push(`${label} → ${status}`)
  }
  const leaked = serviceRequests()
    .slice(before)
    .map((request) => `${request.method} ${request.path}`)
  results.mg3 = { calls: calls + checks.length, mismatches, leakedToService: leaked }
  expect(mismatches).toEqual([])
  expect(leaked).toEqual([])
  // The read-only phone's composer says it may not send (03 §21.2), and its switcher is read-only.
  await readOnly.page.getByTestId("session-list").getByText(state.localSession.title).first().click()
  await expect(readOnly.page.locator("#own-composer-input")).toBeVisible()
  await shot(readOnly.page, "10-phone-read-only")
  // Events: the phone's stream never carries local frames (pairing SAS, host prompts).
  const frames = await phone.page.evaluate(async () => {
    const response = await fetch("/srv/local/api/event")
    const reader = response.body!.getReader()
    let text = ""
    const until = Date.now() + 1500
    while (Date.now() < until) {
      const next = await Promise.race([reader.read(), new Promise<{ done: true }>((resolve) => setTimeout(() => resolve({ done: true }), 400))])
      if (next.done) continue
      text += new TextDecoder().decode((next as { value: Uint8Array }).value)
    }
    await reader.cancel()
    return text
  })
  expect(frames).toContain("server.connected")
  expect(frames).not.toContain("device.pairing")
  expect(frames).not.toContain("host.prompt")
})

test("MG5: the SSH host's session through /srv/<hostId> — prompt and account switch; no host token on the phone", async () => {
  test.skip(!state.host, "fake-SSH host not available")
  const host = state.host!
  const page = phone.page
  const hostRequests: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.origin !== gateway) hostRequests.push(url.origin)
  })
  await page.goto(`${gateway}/srv/${host.id}/s/${host.session.id}`)
  await expect(page.getByTestId("server-badge")).toHaveText(host.name, { timeout: 60_000 })
  const composer = page.locator("#own-composer-input")
  await expect(composer).toBeEnabled({ timeout: 60_000 })
  await composer.fill("휴대폰에서 원격으로")
  await composer.press("Control+Enter")
  await expect(page.getByTestId("transcript").getByText("Alpha 계정으로 온 답").first()).toBeVisible({ timeout: 120_000 })
  await shot(page, "11-phone-remote-session")
  // Switch the account of the remote session (the switcher opens as a bottom sheet on a phone).
  await page.getByTestId("running-on").first().click()
  const switcher = page.getByTestId("switcher")
  await expect(switcher).toBeVisible()
  await switcher.getByTestId("switcher-account").filter({ hasText: "Bravo" }).click()
  await switcher.getByTestId("switcher-apply").click()
  const dialog = page.getByTestId("switch-dialog")
  await expect(dialog.or(page.getByTestId("running-on").filter({ hasText: "@ Bravo" }))).toBeVisible()
  if (await dialog.isVisible()) {
    await dialog.getByTestId("switch-option-now").click()
    await dialog.getByTestId("switch-dialog-confirm").click()
  }
  await expect(page.getByTestId("running-on").first()).toContainText("@ Bravo", { timeout: 30_000 })
  await composer.fill("전환 뒤 원격 질문")
  await composer.press("Control+Enter")
  await expect(page.getByTestId("transcript").getByText("Bravo 계정으로 온 답").first()).toBeVisible({ timeout: 120_000 })
  await shot(page, "12-phone-remote-switched")
  // Everything went to the gateway's origin (/srv/<hostId>), never to 127.0.<k>.2 directly.
  expect([...new Set(hostRequests)]).toEqual([])
  // What the phone received never carries the host's signed token or its service password.
  const received = phone.bodies.join("\n")
  expect(received).not.toContain(host.password)
  expect(received).not.toMatch(/\b\d{10}\.[A-Za-z0-9_-]{43}\b/)
  // Remote rows for the gateway-relayed requests: Basic session token, no cookie, no origin (04 §12.7).
  const events = path.join(state.testRoot, "service-events.jsonl")
  const relayed = fs
    .readFileSync(events, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    // The PC tab talks to the host itself (origin of its page, 04 §12.1); what the gateway relays carries no origin.
    .filter((entry) => entry.kind === "request" && entry.auth === "token" && entry.origin === null)
  expect(relayed.length).toBeGreaterThan(0)
  for (const entry of relayed) expect(entry.cookie).toBe(false)
  results.mg5 = { relayedToHost: relayed.length, directHostRequestsFromPhone: [...new Set(hostRequests)] }
  expect(providerRequests().some((entry) => entry.account === "Bravo")).toBe(true)
  // A disconnected host answers 503 with its stage, not a hang.
  const far = await page.request.get(`${gateway}/srv/${state.farHost}/api/session`)
  expect(far.status()).toBe(503)
})

test("MG6: offline — the service-worker shell and the cached list, the draft kept, no auto-send; back online resyncs and the feed has what happened", async () => {
  const page = phone.page
  await page.goto(`${gateway}/`)
  await expect(page.getByTestId("session-list")).toContainText(state.localSession.title, { timeout: 60_000 })
  // The worker controls the page before going offline.
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 30_000 }).toBe(true)
  const cacheKeys = await page.evaluate(async () => {
    const names = await caches.keys()
    const urls: string[] = []
    for (const name of names) for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname)
    return urls
  })
  results.mg6CachedPaths = cacheKeys
  for (const key of cacheKeys) expect(key).not.toMatch(/^\/(own|auth|api)\/|^\/srv\/[^/]+\/api\//)
  const turnsBefore = providerRequests().length
  await phone.context.setOffline(true)
  await page.reload()
  await expect(page.getByTestId("session-list")).toContainText(state.localSession.title, { timeout: 30_000 })
  await shot(page, "13-phone-offline-list")
  await page.getByTestId("session-list").getByText(state.localSession.title).first().click()
  const composer = page.locator("#own-composer-input")
  await composer.fill("오프라인 초안")
  await composer.press("Control+Enter")
  await shot(page, "14-phone-offline-draft")
  // While the phone is away, the PC finishes a turn: the feed records it.
  const sessionPrompt = await fetch(`${state.serverUrl}/api/session/${state.localSession.id}/prompt`, {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`opencode:${state.localPassword}`)}`, "content-type": "application/json" },
    body: JSON.stringify({ text: "PC에서 보낸 질문" }),
  })
  expect(sessionPrompt.ok).toBe(true)
  await expect.poll(() => providerRequests().length, { timeout: 60_000 }).toBeGreaterThan(turnsBefore)
  const sentWhileOffline = providerRequests().length
  await page.waitForTimeout(2000)
  await phone.context.setOffline(false)
  await expect(page.getByTestId("transcript").getByText("PC에서 보낸 질문")).toBeVisible({ timeout: 60_000 })
  await expect(composer).toHaveValue("오프라인 초안")
  await page.waitForTimeout(3000)
  // No auto-send: the only new model request is the PC's.
  expect(providerRequests().length).toBe(sentWhileOffline)
  await shot(page, "15-phone-back-online")
  const feed = await page.evaluate(async (control) => {
    const response = await fetch(`/srv/local/api/rpc/own.remote/feed.list?location[directory]=${encodeURIComponent(control)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { limit: 200 } }),
    })
    return (await response.json()) as { output: { items: Array<{ kind: string; sessionID?: string; title?: string }> } }
  }, state.control)
  results.mg6Feed = feed.output.items
  expect(feed.output.items.some((item) => item.kind === "turn.completed" && item.sessionID === state.localSession.id)).toBe(true)
  for (const item of feed.output.items) expect(JSON.stringify(item)).not.toContain("PC에서 보낸 질문")
  await composer.fill("")
})

test("MG4: revoke from the PC — the phone's streams close and it shows 인증 필요 within 5 s; other phones keep working", async () => {
  const other = otherPhone
  const page = phone.page
  await page.goto(`${gateway}/s/${state.localSession.id}`)
  await expect(page.locator("#own-composer-input")).toBeVisible()
  await pcPage.goto("/settings/devices")
  const row = pcPage.locator(`[data-testid="pairing-device"][data-device="${phoneDeviceId}"]`)
  await row.getByTestId("pairing-revoke").click()
  const started = Date.now()
  await pcPage.getByTestId("pairing-revoke-confirm").getByTestId("pairing-revoke-ok").click()
  await expect(page.getByTestId("device-pairing")).toBeVisible({ timeout: 5_000 })
  results.mg4RevokeToScreenMs = Date.now() - started
  await expect(page.getByTestId("device-pairing-message")).toContainText("만료됐거나 끊겼어요")
  await shot(page, "16-phone-revoked")
  await expect(row).toHaveAttribute("data-state", "revoked")
  const after = await page.request.get(`${gateway}/srv/local/api/session`)
  expect(after.status()).toBe(401)
  // The other phone is untouched.
  const still = await other.page.request.get(`${gateway}/srv/local/api/session?location[directory]=${encodeURIComponent(state.control)}`)
  expect(still.status()).toBe(200)
  await shot(pcPage, "17-pc-revoked")
})

test("MG8: no plaintext device token, service password, host token or provider key on the phones or in OWN_HOME", async () => {
  const secrets: string[] = [state.localPassword, ...Object.values(FAKE_KEYS)]
  if (state.host) secrets.push(state.host.password)
  const deviceTokens: string[] = []
  for (const entry of phones) {
    if (entry.page.isClosed()) continue
    for (const cookie of await entry.context.cookies()) if (cookie.name === "own_device") deviceTokens.push(cookie.value)
  }
  expect(deviceTokens.length).toBeGreaterThan(0)
  const findings: string[] = []
  for (const [index, entry] of phones.entries()) {
    if (entry.page.isClosed()) continue
    const stored = await deviceStorage(entry.page, entry.context)
    const text = `${stored.text}\n${entry.bodies.join("\n")}`
    for (const secret of [...secrets, ...deviceTokens]) if (text.includes(secret)) findings.push(`phone ${index}: ${secret.slice(0, 6)}…`)
    if (/\b\d{10}\.[A-Za-z0-9_-]{43}\b/.test(text)) findings.push(`phone ${index}: a signed server token`)
  }
  const files: string[] = []
  const walk = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name)
      if (item.isDirectory()) walk(full)
      else files.push(full)
    }
  }
  walk(state.ownHome)
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8")
    for (const secret of [state.localPassword, ...deviceTokens]) if (text.includes(secret)) findings.push(`${path.relative(state.ownHome, file)}`)
  }
  results.mg8 = { phones: phones.length, files: files.map((file) => path.relative(state.ownHome, file)), findings }
  expect(findings).toEqual([])
  expect(files.map((file) => path.basename(file))).toEqual(expect.arrayContaining(["devices.json", "gateway.json"]))
})

// ---------------------------------------------------------------------------------------------------------------
// 08 app connections: the pinned-TLS app listener. The "app" is simulated the way the Android and desktop apps work
// (08 §3.4): native pairing over TLS checked by pin only, then a separate Edge that reaches
// `https://<pcKey>.ownpc.internal/` only through a local CONNECT proxy and trusts only that SPKI pin.

/** The apps' local CONNECT proxy (08 §3.4): `<pcKey>.ownpc.internal:443` → the route, anything else 403. */
function appProxy(appHost: string, route: { readonly host: string; readonly port: number }) {
  const server = net.createServer((client) => {
    client.once("data", (head) => {
      const line = head.toString("latin1").split("\r\n")[0] ?? ""
      const match = /^CONNECT ([^\s:]+):(\d+) HTTP\/1\.[01]$/.exec(line)
      if (!match || match[1] !== appHost || match[2] !== "443") return void client.end("HTTP/1.1 403 Forbidden\r\n\r\n")
      const upstream = net.connect(route.port, route.host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        client.pipe(upstream).pipe(client)
      })
      upstream.on("error", () => client.destroy())
      client.on("error", () => upstream.destroy())
    })
  })
  return new Promise<{ readonly port: number; close(): void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() })),
  )
}

/** A native app request: TLS straight to the route with the app host as SNI and Host, the certificate checked by pin. */
function appCall(
  route: { readonly host: string; readonly port: number },
  appHost: string,
  pin: string,
  pathname: string,
  init: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string } = {},
) {
  return new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
    const request = https.request(
      {
        host: route.host,
        port: route.port,
        path: pathname,
        method: init.method ?? "GET",
        servername: appHost,
        rejectUnauthorized: false,
        // A fresh connection each call: Node's agent resumes TLS sessions, and a resumed session carries no certificate.
        agent: false,
        headers: { host: appHost, "user-agent": "OwnOpenCodeApp/1 (android) Android/15", ...init.headers },
      },
      (response) => {
        const socket = response.socket as TLSSocket
        const spki = socket.getPeerX509Certificate()!.publicKey.export({ type: "spki", format: "der" })
        if (createHash("sha256").update(spki).digest("base64url") !== pin) return reject(new Error("pin mismatch"))
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk: string) => (body += chunk))
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }))
      },
    )
    request.on("error", reject)
    if (init.body !== undefined) request.write(init.body)
    request.end()
  })
}

test("AA: 앱 연결 — turned on in 설정 > 기기; an Android app pairs natively and opens the PC through the pinned route", async ({ playwright }) => {
  await pcPage.goto("/settings/devices")
  const section = pcPage.getByTestId("pairing-app")
  await expect(section).toBeVisible()
  await section.getByTestId("pairing-app-enable").click()
  await pcPage.getByTestId("pairing-app-plan-confirm").click()
  await expect(section).toHaveAttribute("data-state", "listening", { timeout: 30_000 })
  await expect(section.getByTestId("pairing-app-pin")).toContainText("인증서 지문")
  await shot(pcPage, "20-pc-app-access")
  const view = (await rpc("gateway.status", {})).body.output as OwnRemote.GatewayView
  const app = view.app!
  expect(app).toMatchObject({ state: "listening", problem: null })
  const appHost = `${app.pcKey}.ownpc.internal`
  const route = { host: "127.0.0.1", port: app.port! }
  expect(app.routes.map((item) => item.address)).toContain(`127.0.0.1:${app.port}`)

  // 새 기기 연결 → Android 앱: the QR is an ownpc:// link with the pin and the routes.
  const form = pcPage.getByTestId("pairing-new")
  await form.getByTestId("pairing-target").getByText("Android 앱").click()
  await form.getByTestId("pairing-name").fill("안드로이드 앱")
  await form.getByTestId("pairing-create").click()
  await expect(form.getByTestId("pairing-qr")).toBeVisible()
  await shot(pcPage, "21-pc-app-qr")
  const link = new URL((await form.getByTestId("pairing-url").textContent())!.trim())
  expect(link.protocol).toBe("ownpc:")
  expect(link.searchParams.get("p")).toBe(app.pin)
  const opened = await appCall(route, appHost, app.pin!, `/auth/connect/${link.searchParams.get("c")}`, {
    headers: { accept: "application/json" },
  })
  expect(opened.status).toBe(200)
  const { claim, sas } = JSON.parse(opened.body) as { claim: string; sas: string }
  const dialog = pcPage.getByTestId("pairing-approve")
  await expect(dialog.getByTestId("pairing-sas")).toHaveText(sas)
  await expect(dialog).toContainText("Own 앱 · Android")
  await shot(pcPage, "22-pc-app-approve")
  await dialog.getByTestId("pairing-allow").click()
  await expect
    .poll(async () => JSON.parse((await appCall(route, appHost, app.pin!, "/own/pairing", { headers: { "x-own-pairing": claim } })).body).state)
    .toBe("approved")
  const claimed = await appCall(route, appHost, app.pin!, "/own/pairing/claim", {
    method: "POST",
    headers: { "x-own-pairing": claim, "content-type": "application/json" },
    body: "{}",
  })
  expect(claimed.status).toBe(200)
  const token = (JSON.parse(claimed.body) as { token: string }).token
  await expect(pcPage.locator('[data-testid="pairing-device"]').filter({ hasText: "안드로이드 앱" })).toBeVisible({ timeout: 30_000 })

  // The app's WebView: the CONNECT proxy only, the pin only.
  const proxy = await appProxy(appHost, route)
  const appAgent = `${PHONE.userAgent} OwnOpenCodeApp/1 (android)`
  const edge = await playwright.chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      `--proxy-server=http://127.0.0.1:${proxy.port}`,
      `--ignore-certificate-errors-spki-list=${Buffer.from(app.pin!, "base64url").toString("base64")}`,
      "--proxy-bypass-list=<-loopback>",
    ],
  })
  try {
    const context = await edge.newContext({ ...PHONE, userAgent: appAgent })
    await context.addCookies([{ name: "own_device", value: token, url: `https://${appHost}`, httpOnly: true, secure: true, sameSite: "Strict" }])
    const page = await context.newPage()
    await page.goto(`https://${appHost}/`)
    await expect(page.getByTestId("session-list")).toContainText(state.localSession.title, { timeout: 60_000 })
    await shot(page, "23-app-session-list")
    expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((list) => list.length))).toBe(0)
    // No credential: the app's own message, not the browser QR instructions.
    const fresh = await edge.newContext({ ...PHONE, userAgent: appAgent })
    const unpaired = await fresh.newPage()
    await unpaired.goto(`https://${appHost}/`)
    await expect(unpaired.getByTestId("device-pairing")).toContainText("앱의 PC 목록")
    await fresh.close()
    await context.close()
  } finally {
    await edge.close()
  }
  // Without the pin the same origin is refused: the certificate has no CA behind it.
  const plain = await playwright.chromium.launch({
    channel: "msedge",
    headless: true,
    args: [`--proxy-server=http://127.0.0.1:${proxy.port}`, "--proxy-bypass-list=<-loopback>"],
  })
  try {
    const page = await (await plain.newContext()).newPage()
    const failure = await page.goto(`https://${appHost}/`).then(
      () => "loaded",
      (error: Error) => error.message,
    )
    expect(failure).toMatch(/ERR_CERT/)
  } finally {
    await plain.close()
    proxy.close()
  }
  results.appAccess = { pcKey: app.pcKey, routes: app.routes }
})

/** The app listener on, through the RPC (AA turns it on in the UI; a run of AA-M alone starts from here). */
async function appListening() {
  const status = async () => (await rpc("gateway.status", {})).body.output as OwnRemote.GatewayView
  const configure = async (input: Record<string, unknown>) => {
    const plan = await rpc("gateway.configure.plan", input)
    expect(plan.status).toBe(200)
    expect((await rpc("gateway.configure.execute", { nonce: plan.body.output.nonce })).status).toBe(200)
  }
  if ((await status()).state !== "listening") await configure({ port: state.gatewayPort })
  if ((await status()).app?.state !== "listening") await configure({ app: { enabled: true } })
  return (await status()).app!
}

test("AA-M: 모바일 미리보기 — Pixel 7 as the Android app, through the loopback link and the PC's 허용; revoked, the app's message", async ({ playwright }) => {
  const app = await appListening()
  const appHost = `${app.pcKey}.ownpc.internal`
  const route = { host: "127.0.0.1", port: app.port! }
  // own-desktop's preview window (remote-pcs/emulation.ts): the app's user agent plus its own token.
  const previewAgent = `${devices["Pixel 7"].userAgent} OwnOpenCodeApp/1 (android) OwnPreview/1`
  await pcPage.goto("/settings/devices")
  await expect(pcPage.getByTestId("pairing-app")).toHaveAttribute("data-state", "listening")

  // What 설정 > 기기 asks for and hands to the shell: one loopback route, nothing else.
  const started = await rpc("devices.pair.start", {
    name: "모바일 미리보기 (이 PC)",
    scopes: ["read", "prompt", "switch"],
    servers: { mode: "all" },
    expiresDays: 7,
    appRoute: "loopback",
  })
  expect(started.status).toBe(200)
  const link = new URL(started.body.output.appLink)
  expect(link.searchParams.getAll("r")).toEqual([`127.0.0.1:${app.port}`])
  expect(link.searchParams.get("p")).toBe(app.pin)

  // The shell pairs over the pinned route as the preview; the PC still has to press 허용.
  const opened = await appCall(route, appHost, app.pin!, `/auth/connect/${link.searchParams.get("c")}`, {
    headers: { accept: "application/json", "user-agent": previewAgent },
  })
  expect(opened.status).toBe(200)
  const { claim, sas } = JSON.parse(opened.body) as { claim: string; sas: string }
  const dialog = pcPage.getByTestId("pairing-approve")
  await expect(dialog.getByTestId("pairing-sas")).toHaveText(sas)
  await expect(dialog).toContainText("Own 모바일 미리보기 · Windows")
  await shot(pcPage, "24-pc-preview-approve")
  await dialog.getByTestId("pairing-allow").click()
  await expect
    .poll(async () => JSON.parse((await appCall(route, appHost, app.pin!, "/own/pairing", { headers: { "x-own-pairing": claim } })).body).state)
    .toBe("approved")
  const claimed = await appCall(route, appHost, app.pin!, "/own/pairing/claim", {
    method: "POST",
    headers: { "x-own-pairing": claim, "content-type": "application/json", "user-agent": previewAgent },
    body: "{}",
  })
  expect(claimed.status).toBe(200)
  const { token, deviceId } = JSON.parse(claimed.body) as { token: string; deviceId: string }
  const listed = pcPage.locator(`[data-testid="pairing-device"][data-device="${deviceId}"]`)
  await expect(listed).toContainText("Own 모바일 미리보기 · Windows", { timeout: 30_000 })
  await expect(listed).toContainText("앱")

  // The preview window as own-web sees it: Pixel 7 (412 px, touch), the CONNECT proxy only, the pin only.
  const proxy = await appProxy(appHost, route)
  const edge = await playwright.chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      `--proxy-server=http://127.0.0.1:${proxy.port}`,
      `--ignore-certificate-errors-spki-list=${Buffer.from(app.pin!, "base64url").toString("base64")}`,
      "--proxy-bypass-list=<-loopback>",
    ],
  })
  const audits: Record<string, unknown> = {}
  try {
    const context = await edge.newContext({ ...devices["Pixel 7"], userAgent: previewAgent, locale: "ko-KR" })
    await context.addCookies([{ name: "own_device", value: token, url: `https://${appHost}`, httpOnly: true, secure: true, sameSite: "Strict" }])
    const page = await context.newPage()
    await page.goto(`https://${appHost}/`)
    await expect(page.getByTestId("session-list")).toContainText(state.localSession.title, { timeout: 60_000 })
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true)
    expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((list) => list.length))).toBe(0)
    const audit = async (name: string) => {
      const result = await touchAudit(page)
      audits[name] = result
      expect({ name, width: result.width, panned: result.panned, small: result.small }).toEqual({ name, width: 412, panned: 0, small: [] })
      expect(result.controls).toBeGreaterThan(3)
    }
    await audit("list")
    await shot(page, "25-preview-list")
    await page.getByTestId("session-list").getByText(state.localSession.title).first().click()
    await expect(page).toHaveURL(new RegExp(`/s/${state.localSession.id}$`))
    const composer = page.locator("#own-composer-input")
    await expect(composer).toBeVisible()
    await audit("session")
    await composer.fill("미리보기에서 안녕")
    await composer.press("Control+Enter")
    await expect(page.getByTestId("transcript").getByText("미리보기에서 안녕")).toBeVisible({ timeout: 30_000 })
    await shot(page, "26-preview-session")
    // 설정 > 기기 > 폐기 (or the preview's own 지우기): the open page shows the app's message at once.
    expect((await rpc("devices.revoke", { deviceId })).status).toBe(200)
    await expect(page.getByTestId("device-pairing")).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId("device-pairing-message")).toContainText("앱의 PC 목록")
    await shot(page, "27-preview-revoked")
    await context.close()
  } finally {
    await edge.close()
    proxy.close()
  }
  results.mobilePreview = { pcKey: app.pcKey, route: `127.0.0.1:${app.port}`, audits }
})
