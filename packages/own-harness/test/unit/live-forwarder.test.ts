// The live kit's forwarder (script/live/forwarder.ts) never forwards ChatGPT's usage-limit reset credits
// (own-accounts 02 §7.1.1): listing or redeeming one answers 404 on every route, HTTP or WebSocket, before any
// credential is read. The profiles folder points at a folder that does not exist, so a credential read would fail
// with 500 instead; nothing here reaches chatgpt.com.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "own-live-forwarder-"))
process.env.OWN_LIVE_PROFILES = path.join(root, "no-profiles")
// The `/local` route's server: a model stream of a keepalive comment, two events and the end marker.
const STREAM = [": keep-alive", 'data: {"a":1}', 'data: {"b":2}', "data: [DONE]"].map((line) => `${line}\n\n`).join("")
const local = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(STREAM, { headers: { "content-type": "text/event-stream" } }),
})
process.env.OWN_LIVE_LOCAL_URL = `http://127.0.0.1:${local.port}/v1`
delete process.env.OWN_LIVE_LOCAL_UPSTREAM
const { profileListing, redact, route, startForwarder } = await import("../../script/live/forwarder.js")

const REFUSED = [
  ["GET", "/chatgpt-backend/01/wham/rate-limit-reset-credits"],
  ["POST", "/chatgpt-backend/01/wham/rate-limit-reset-credits/consume"],
  ["POST", "/chatgpt-backend/03/wham/rate-limit-reset-credits/consume"],
  ["POST", "/chatgpt/01/wham/rate-limit-reset-credits/consume"],
  ["POST", "/chatgpt/03/api/codex/rate-limit-reset-credits/consume"],
  ["GET", "/chatgpt/01/api/codex/Rate-Limit-Reset-Credits"],
  ["POST", "/chatgpt-team/wham/rate-limit-reset-credits/consume"],
] as const

describe("live forwarder: reset credits", () => {
  const log = path.join(root, "forwarder.jsonl")
  const state: { forwarder?: Awaited<ReturnType<typeof startForwarder>> } = {}
  beforeAll(() => {
    state.forwarder = startForwarder(log, { "acct-team": "01" })
  })
  afterAll(async () => {
    await state.forwarder?.stop()
    await fs.rm(root, { recursive: true, force: true })
  })

  test("every reset credit path is refused with 404 and nothing is forwarded or logged", async () => {
    const url = state.forwarder?.url ?? ""
    const answers = await Promise.all(
      REFUSED.map(async ([method, pathname]) => {
        const response = await fetch(url + pathname, {
          method,
          headers: { "chatgpt-account-id": "acct-team", "content-type": "application/json" },
          ...(method === "POST" ? { body: JSON.stringify({ redeem_request_id: "never-sent" }) } : {}),
        })
        return [pathname, response.status, await response.text()]
      }),
    )
    expect(answers).toEqual(REFUSED.map(([, pathname]) => [pathname, 404, "unknown route"]))
    expect(await Bun.file(log).exists()).toBe(false)
  })

  test("the route table itself refuses them before reading a credential", async () => {
    for (const [, pathname] of REFUSED) expect(await route(pathname, "01")).toBeUndefined()
    // The usage read stays a route: it would read the (missing) profile, which is what makes it fail here.
    await expect(route("/chatgpt-backend/01/wham/usage", undefined)).rejects.toThrow()
  })

  test("a WebSocket upgrade to a reset credit path is closed as an unknown route", async () => {
    const socket = new WebSocket(
      `${(state.forwarder?.url ?? "").replace(/^http/, "ws")}/chatgpt/01/wham/rate-limit-reset-credits`,
    )
    const closed = await new Promise<number>((resolve) => {
      socket.onclose = (event) => resolve(event.code)
    })
    expect(closed).toBe(1008)
  })
})

// A tool's output can hold this PC's identity whatever environment the test server gets (a sub-agent's `bunx biome`
// printed its cache folder under the user's profile, 2026-11-07), so every body leaves with it replaced.
describe("live forwarder: identity", () => {
  const home = os.userInfo().homedir
  const name = path.basename(home)
  // A short or generic home folder name is left alone (it would replace ordinary words).
  const eligible = name.length >= 4 && !["unknown", "user", "admin", "test"].includes(name.toLowerCase())

  test.if(eligible)("the user name goes in raw, JSON-escaped and slash paths, not inside other words", () => {
    const cache = path.join(home, "AppData", "Local", "biomejs", "biome", "cache")
    for (const text of [`[default: ${cache}]`, JSON.stringify({ content: cache }), `C:/Users/${name}/x`])
      expect(redact(text).toLowerCase()).not.toContain(name.toLowerCase())
    expect(redact(`${name}x and users`)).toBe(`${name}x and users`)
    expect(redact(`d---- _bazel_${name}`)).toBe("d---- _bazel_user")
    // A `C:\Users` listing in a JSON body: the name follows the escaped line break's letter.
    const listing = JSON.stringify({ content: `Name\r\n----\r\nAll Users\r\nDefault\r\n${name}\r\nPublic\r\n` })
    expect(redact(listing).toLowerCase()).not.toContain(name.toLowerCase())
    expect(redact(JSON.stringify(listing)).toLowerCase()).not.toContain(name.toLowerCase())
  })

  // Test runs give the forwarder a fake profile and no USERNAME; the logon account still goes (2026-11-12, `ls -l`).
  const account = Bun.spawnSync(["whoami"]).stdout.toString().trim().split("\\").pop() ?? ""
  test.if(account.length >= 4)("the logon account goes even with a fake profile and no USERNAME", () => {
    const fake = mkdtempSync(path.join(os.tmpdir(), "fwd-id-"))
    const line = JSON.stringify({ content: `drwxr-xr-x 1 ${account} 197121 0 Nov 12 09:15 .git` })
    const script = `const { redact } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../../script/live/forwarder.ts"))}); process.stdout.write(redact(${JSON.stringify(line)}))`
    const env = Object.fromEntries(
      ["PATH", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "TEMP", "TMP"].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
    )
    const out = Bun.spawnSync([process.execPath, "-e", script], { env: { ...env, USERPROFILE: fake, HOME: fake } })
    rmSync(fake, { recursive: true, force: true })
    expect(out.exitCode).toBe(0)
    expect(out.stdout.toString().toLowerCase()).not.toContain(account.toLowerCase())
  })

  test("a listing of the Windows profiles or of a profile's own folders is told apart from code", () => {
    expect(profileListing("Name\r\n----\r\nAll Users\r\nDefault\r\nDefault User\r\nPublic")).toBe(true)
    expect(profileListing("l--hs Application Data\nd-r-- Contacts\nl--hs NetHood\nl--hs PrintHood")).toBe(true)
    expect(profileListing('import { sendTo } from "./mail"\n// SendTo is a verb here')).toBe(false)
  })

  test("other people's e-mails in package metadata stay", () => {
    const text = '"author": "Jane Example <jane.example@gmail.com>"'
    expect(redact(text)).toBe(text)
  })
})

describe("live forwarder: response accounting", () => {
  afterAll(() => local.stop(true))

  test("a model response passes unchanged and logs a stream line with its bytes, events and comments", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "own-live-stream-"))
    const log = path.join(dir, "stream.jsonl")
    const forwarder = startForwarder(log)
    const response = await fetch(`${forwarder.url}/local/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true }),
    })
    const text = await response.text()
    expect(text).toBe(STREAM)
    // The line is written once the body ends; give the append a moment.
    const lines = await Bun.sleep(100).then(() => fs.readFile(log, "utf8"))
    await forwarder.stop()
    await fs.rm(dir, { recursive: true, force: true })
    const stream = lines
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((line) => line.stream)?.stream
    expect(stream).toMatchObject({ bytes: Buffer.byteLength(text), events: 3, comments: 1, outcome: "end" })
    expect(stream.firstByteMs).toBeGreaterThanOrEqual(0)
  })
})
