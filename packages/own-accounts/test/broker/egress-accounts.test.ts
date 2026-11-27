// Egress proof v2 (04 §8.11.0 item 3, 02 §8.7, G5): the relay signs a host's request with the Claude account its proof
// names, the MAC covers that account, the host's account scope decides which accounts it may name, and nothing ever
// falls back to a default. A fake multi-account claude-auth (the patched plugin's exports) and a fake upstream; every
// token is fake.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHmac, randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Broker, type Limit } from "@own/protocol"
import { ClaudeWire } from "../../src/broker/claude-wire.js"
import { Egress } from "../../src/broker/egress.js"
import { Logger } from "../../src/logger.js"
import { writeFakeClaudeAuth, type FakeState } from "../support/fake-claude-auth.js"

const HOST = "h-egress2"
const EPOCH = 1_790_000_100
const KEY = randomBytes(32)
const SLOT = "acc_claude_slot"
const TWO = "acc_01J9CLAUDETWO0000000000000"
const OUTSIDE = "acc_01J9CLAUDEOUTSIDE000000000"
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "own-egress-accounts-")))
const counter = { n: 0 }
const keys: Record<string, string> = { [SLOT]: "c:\\fake\\one", [TWO]: "c:\\fake\\two", [OUTSIDE]: "c:\\fake\\out" }

let fake: FakeState
let multi: string
let single: string

beforeAll(async () => {
  const shim = writeFakeClaudeAuth(path.join(root, "multi"), { multi: true, account: { source: "file", token: "t" } })
  multi = shim.entry
  fake = ((await import(shim.module)) as { fake: FakeState }).fake
  fake.accounts = { [keys[SLOT]!]: "tok-one", [keys[TWO]!]: "tok-two", [keys[OUTSIDE]!]: "tok-out" }
  single = writeFakeClaudeAuth(path.join(root, "single"), { account: { source: "file", token: "tok-single" } }).entry
})

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

function proof(accountID: string, input: { readonly macAccount?: string } = {}) {
  const n = ++counter.n
  const mac = createHmac("sha256", KEY)
    .update(Broker.egressMacInput({ hostId: HOST, epoch: EPOCH, n, accountID: input.macAccount ?? accountID }))
    .digest("hex")
  return Broker.egressHeader({ epoch: EPOCH, n, accountID, mac })
}

async function rig(entry: string, scope: ReadonlyArray<string>) {
  const seen: Array<{ token: string | undefined }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      await request.text()
      seen.push({ token: request.headers.get("authorization")?.replace(/^Bearer /, "") })
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "anthropic-ratelimit-unified-5h-utilization": "0.42" },
      })
    },
  })
  const limits: Limit.Window[] = []
  const relay = new Egress.Relay({
    now: Date.now,
    log: Logger.silent,
    upstream: `http://127.0.0.1:${server.port}`,
    wire: () => ClaudeWire.load(entry, path.join(path.dirname(entry), "state")),
    limits: (windows) => limits.push(...windows),
    audit: async () => {},
    changed: () => {},
  })
  const port = await relay.listen(HOST, {
    local: async () => ({ ok: false, status: 404, code: "not_found" }),
    key: () => ({ epoch: EPOCH, key: KEY }),
    state: () => "enabled",
    // As the broker host answers it: one of this PC's Claude accounts inside the host's scope, with its plugin key.
    account: (accountID) =>
      scope.includes(accountID) && keys[accountID] !== undefined
        ? { key: entry === single && accountID === SLOT ? undefined : keys[accountID] }
        : undefined,
  })
  const send = (header: string) =>
    fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [Broker.EGRESS_HEADER]: header,
        "x-opencode-session-id": "ses_host_1",
      },
      body: JSON.stringify({ model: "claude-fake", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    })
  return {
    seen,
    limits,
    send,
    async [Symbol.asyncDispose]() {
      await relay.shutdown()
      server.stop(true)
    },
  }
}

describe("egress proof v2", () => {
  test("each request is signed with the account its proof names; the windows are that account's", async () => {
    await using r = await rig(multi, [SLOT, TWO])
    fake.prepared.length = 0
    const responses = await Promise.all([r.send(proof(TWO)), r.send(proof(SLOT)), r.send(proof(TWO))])
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200])
    expect(r.seen.map((item) => item.token).sort()).toEqual(["tok-one", "tok-two", "tok-two"])
    expect(fake.prepared.map((item) => item.source).sort()).toEqual([keys[SLOT], keys[TWO], keys[TWO]].sort())
    // G7: the host's conversation reaches the plugin.
    expect(fake.prepared.every((item) => item.conversationID === "ses_host_1")).toBe(true)
    expect(r.limits.map((window) => String(window.accountID)).sort()).toEqual([TWO, TWO, SLOT])
  })

  test("the MAC covers the account: a proof moved to another account is refused before anything is read", async () => {
    await using r = await rig(multi, [SLOT, TWO])
    const moved = await r.send(proof(TWO, { macAccount: SLOT }))
    expect(moved.status).toBe(401)
    expect(moved.headers.get(Broker.EGRESS_ERROR_HEADER)).toBe("mac")
    // v1 (no account) is not accepted any more.
    const n = ++counter.n
    const v1 = `v1.${EPOCH}.${n}.${createHmac("sha256", KEY).update(`own-egress/v1|${HOST}|${EPOCH}|${n}`).digest("hex")}`
    expect((await r.send(v1)).status).toBe(401)
    expect(r.seen).toHaveLength(0)
  })

  test("an account outside the host's scope, or not this PC's, is refused; never another account instead", async () => {
    await using r = await rig(multi, [TWO])
    for (const accountID of [OUTSIDE, SLOT, "acc_01J9NOTAPCACCOUNT0000000000"]) {
      const response = await r.send(proof(accountID))
      expect(response.status).toBe(403)
      expect(response.headers.get(Broker.EGRESS_ERROR_HEADER)).toBe("host_scope")
    }
    expect(r.seen).toHaveLength(0)
  })

  test("a plugin that runs one account signs only the slot's own; another account is not ready", async () => {
    await using r = await rig(single, [SLOT, TWO])
    expect((await r.send(proof(SLOT))).status).toBe(200)
    const other = await r.send(proof(TWO))
    expect(other.status).toBe(403)
    expect(other.headers.get(Broker.EGRESS_ERROR_HEADER)).toBe("not_ready")
    expect(r.seen.map((item) => item.token)).toEqual(["tok-single"])
  })
})
