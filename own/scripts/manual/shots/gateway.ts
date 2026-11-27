// Group G: phones and other PCs on own-web's gateway e2e backend (packages/own-web/e2e/gateway/backend.ts): the real
// own-remote gateway and app connection on loopback (memory vault, no Tailscale, no port forwarding), the PC page
// through Vite dev and a phone tab on the gateway. One story: turn on the gateway and the app connection in
// 설정 > 기기, the new-device form for an Android app and for another PC, a browser phone pairing (both screens'
// confirmation number), and the device list.
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { REPO, type Locator, type Page } from "../lib/browser"
import type { Ctx, Endpoints, Shot } from "../lib/ctx"
import { DEMO_PC } from "../lib/privacy"
import { checkoutTmp, start } from "../lib/world"

export interface GatewayState extends Endpoints {
  readonly gatewayPort: number
  readonly ownHome: string
  readonly serverRoot: string
  readonly testRoot: string
}

/** App links carry the PC's name (`n=`): shown as the demo PC's. */
const host = os.hostname()
const PC_NAME = [`n=${host}&`, `n=${host.toUpperCase()}&`, `n=${host.toLowerCase()}&`].map((from) => ({
  from,
  to: `n=${DEMO_PC}&`,
}))

export const gatewayPaths = (state: GatewayState) => ({ root: state.serverRoot, extra: PC_NAME })

const uqr = createRequire(path.join(REPO, "packages/own-web/package.json"))("uqr") as {
  encode(text: string, options: { ecc: "M"; border: number }): { size: number; data: boolean[][] }
}

/**
 * The pairing QR drawn again from the link as shown (the PC's name rewritten), the same way own-web draws it
 * (src/pairing/qr.tsx): the image must not carry this PC's name either.
 */
async function redrawQr(form: Locator) {
  const link = (await tid(form, "pairing-url").textContent())!.trim()
  const shown = PC_NAME.reduce((text, pair) => text.replaceAll(pair.from, pair.to), link)
  const code = uqr.encode(shown, { ecc: "M", border: 0 })
  const d = code.data.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : []))).join("")
  await tid(form, "pairing-qr").evaluate(
    (svg, input) => {
      const quiet = 4
      const total = input.size + quiet * 2
      svg.setAttribute("viewBox", `${-quiet} ${-quiet} ${total} ${total}`)
      const rect = svg.querySelector("rect")
      rect?.setAttribute("width", String(total))
      rect?.setAttribute("height", String(total))
      svg.querySelector("path")?.setAttribute("d", input.d)
    },
    { size: code.size, d },
  )
}

export function bootGateway() {
  return start<GatewayState>(
    "gateway",
    {
      script: "e2e/gateway/backend.ts",
      env: { OWN_WEB_E2E_GATEWAY_PORT: "6341", OWN_WEB_E2E_GATEWAY_REMOTE: "0" },
      ready: "OWN_WEB_E2E_GATEWAY_READY",
      file: path.join(checkoutTmp("own-web-e2e-gateway"), "backend.json"),
    },
    gatewayPaths,
  )
}

type C = Ctx<GatewayState>
const shot = (id: string, run: (ctx: C) => Promise<void>): Shot<GatewayState> => ({ id, run })
const tid = (page: Page | Locator, id: string) => page.getByTestId(id)

/** The PC tab the story continues on. */
const story: { pc?: Page } = {}

async function devices(ctx: C) {
  const page = story.pc ?? (await ctx.page({ path: false, keep: true }))
  story.pc = page
  await page.goto("/settings/devices")
  await page.waitForTimeout(1500)
  if (await tid(page, "panel").isVisible().catch(() => false)) await tid(page, "panel-toggle").first().click()
  await page.waitForTimeout(300)
  return page
}

/** The new-device form for `target` (its label), named; `before` sees it filled in. Created: the QR or link. */
async function newDevice(
  page: Page,
  target: string | undefined,
  name: string,
  before?: (form: Locator) => Promise<void>,
) {
  const form = tid(page, "pairing-new")
  if (target) await tid(form, "pairing-target").getByText(target, { exact: true }).click()
  await tid(form, "pairing-name").fill(name)
  if (before) await before(form)
  await tid(form, "pairing-create").click()
  await tid(form, "pairing-url").waitFor({ timeout: 30_000 })
  await page.waitForTimeout(800)
  if ((await tid(form, "pairing-qr").count()) > 0) await redrawQr(form)
  return form
}

export const GATEWAY: ReadonlyArray<Shot<GatewayState>> = [
  shot("23-devices", async (ctx) => {
    const page = await devices(ctx)
    const listening = page.locator('[data-testid="pairing-gateway-state"][data-state="listening"]')
    if (!(await listening.isVisible())) {
      await tid(page, "pairing-port").fill(String(ctx.state.gatewayPort))
      await tid(page, "pairing-enable").click()
      await tid(tid(page, "pairing-plan"), "pairing-plan-confirm").click()
    }
    await listening.waitFor({ timeout: 60_000 })
    const app = tid(page, "pairing-app")
    if (!(await page.locator('[data-testid="pairing-app"][data-state="listening"]').isVisible())) {
      await tid(app, "pairing-app-enable").click()
      await tid(page, "pairing-app-plan-confirm").click()
    }
    await page.locator('[data-testid="pairing-app"][data-state="listening"]').waitFor({ timeout: 60_000 })
    // Tall enough for the gateway, Tailscale and app connection sections together.
    await page.setViewportSize({ width: 1440, height: 1500 })
    await page.waitForTimeout(1000)
    await ctx.shoot(page, "23-devices", {
      clip: [tid(page, "pairing-gateway"), app],
      pad: 20,
      marks: [tid(page, "pairing-gateway"), tid(page, "pairing-tailscale"), app],
    })
    await page.setViewportSize({ width: 1440, height: 900 })
  }),
  shot("23-new-device", async (ctx) => {
    const page = await devices(ctx)
    const form = await newDevice(page, "Android 앱", "내 휴대폰", async (filled) => {
      await filled.scrollIntoViewIfNeeded()
      await page.waitForTimeout(500)
      await ctx.shoot(page, "23-new-device", {
        clip: filled,
        marks: [tid(filled, "pairing-target"), filled.getByText("권한", { exact: true }).first()],
      })
    })
    await tid(form, "pairing-qr").scrollIntoViewIfNeeded()
    await ctx.shoot(page, "23-new-device-qr", { clip: form, marks: [tid(form, "pairing-qr")] })
  }),
  shot("23-other-pc", async (ctx) => {
    const page = await devices(ctx)
    const form = await newDevice(page, "다른 PC (데스크톱 앱)", "사무실 PC")
    await tid(form, "pairing-url").scrollIntoViewIfNeeded()
    await ctx.shoot(page, "23-other-pc", { clip: form, marks: [tid(form, "pairing-url")] })
  }),
  shot("23-phone-pair", async (ctx) => {
    const page = await devices(ctx)
    const form = await newDevice(page, "브라우저", "내 휴대폰 (브라우저)")
    const url = (await tid(form, "pairing-url").textContent())!.trim()
    const phone = await ctx.page({ phone: true, path: false })
    await phone.goto(url)
    await tid(phone, "device-sas").waitFor({ timeout: 60_000 })
    await phone.waitForTimeout(800)
    await ctx.shoot(phone, "23-phone-pair", { marks: [tid(phone, "device-sas")] })
    const dialog = tid(page, "pairing-approve")
    await dialog.waitFor({ timeout: 30_000 })
    await page.waitForTimeout(600)
    await ctx.shoot(page, "23-approve", {
      clip: dialog,
      marks: [tid(dialog, "pairing-sas"), tid(dialog, "pairing-allow")],
    })
    await tid(dialog, "pairing-allow").click()
    await tid(page, "pairing-device").first().waitFor({ timeout: 60_000 })
  }),
  shot("23-device-list", async (ctx) => {
    const page = await devices(ctx)
    const list = tid(page, "pairing-devices")
    await tid(list, "pairing-device").first().waitFor({ timeout: 30_000 })
    await list.scrollIntoViewIfNeeded()
    await ctx.shoot(page, "23-device-list", {
      clip: list,
      marks: [tid(list, "pairing-revoke").first(), tid(page, "pairing-revoke-all")],
    })
  }),
]
