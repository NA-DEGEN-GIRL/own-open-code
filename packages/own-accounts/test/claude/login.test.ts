// `Claude 계정 추가` (02 §8.7, 2026-10-10): Claude Code's own login in a window, played by a fake CLI that is a Bun script
// (never a compiled program, never the real Claude Code). own watches only the credentials file's existence and time
// and the exit code, then reads the e-mail and account uuid of `.claude.json`. Every login and token here is fake.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Account } from "@own/protocol"
import { ClaudeLogin } from "../../src/claude/login.js"
import { login } from "../support/claude-auth-bundle.js"
import { call, ok } from "../plugins/support.js"
import { request, world } from "./support.js"

/** Polls the login until it is no longer waiting (the fake CLI is a Bun process: it takes a moment to start). */
async function finished(w: Awaited<ReturnType<typeof world>>, attemptID: string) {
  const status = { value: await ok(w.claude.addStatus, { attemptID }) }
  for (let index = 0; index < 400 && status.value.state === "waiting"; index++) {
    await Bun.sleep(50)
    status.value = await ok(w.claude.addStatus, { attemptID })
  }
  return status.value
}

setDefaultTimeout(40_000)

describe("adding a Claude account", () => {
  test("a login in the window becomes an account with its own folder; the plugin's list follows", async () => {
    await using w = await world()
    await w.claude.start()
    const plan = await ok(w.claude.addPlan, {})
    expect(plan.cli).toBe(process.execPath)
    expect(plan.folder.startsWith(w.deps.runtime.layout.claudeAccounts)).toBe(true)
    // The fake plugin holds a login of the new folder once the list names it (as the patched one does).
    w.fake.accounts[ClaudeLogin.key(plan.folder)] = "tok-new"
    const { attemptID } = await ok(w.claude.addExecute, { nonce: plan.nonce })
    const status = await finished(w, attemptID)
    expect(status.state).toBe("added")
    expect(status.label).toBe("Claude Max · ma***@…")
    const added = w.registry.claudeAccounts?.[0]
    expect(added).toMatchObject({
      accountID: status.accountID,
      configDir: plan.folder,
      key: ClaudeLogin.key(plan.folder),
      managed: true,
      email: "ma***@…",
      accountUuid: "uuid-new",
    })
    // The window got only the allowlisted system variables and its folder: no ANTHROPIC_*, CLAUDE_* or own variable.
    const seen = JSON.parse(fs.readFileSync(path.join(plan.folder, "env.json"), "utf8")) as {
      names: string[]
      args: string[]
    }
    expect(seen.args).toEqual(["auth", "login", "--claudeai"])
    const leaked = seen.names.filter(
      (name) =>
        /^(ANTHROPIC_|OPENCODE_|OWN_)/i.test(name) ||
        (/^CLAUDE_/i.test(name) && name.toUpperCase() !== "CLAUDE_CONFIG_DIR"),
    )
    expect(leaked).toEqual([])
    const listed = JSON.parse(fs.readFileSync(path.join(w.stateDir, "claude-accounts.json"), "utf8"))
    expect(listed.accounts.map((item: { configDir: string }) => item.configDir)).toContain(plan.folder)
  })

  test("the same login twice is refused and its new folder removed", async () => {
    await using w = await world({ mode: "dup" })
    // Account 1 is that login already (Claude Code's default folder, uuid-1).
    login(path.join(w.home, ".claude"), { token: "fake-1", uuid: "uuid-1", email: "dup@example.test" })
    await w.claude.start()
    const plan = await ok(w.claude.addPlan, {})
    const { attemptID } = await ok(w.claude.addExecute, { nonce: plan.nonce })
    const status = await finished(w, attemptID)
    expect(status).toEqual({ state: "duplicate", accountID: Account.ID.claudeSlot })
    expect(fs.existsSync(plan.folder)).toBe(false)
    expect(w.registry.claudeAccounts ?? []).toEqual([])
  })

  test("a window closed without a login, and one left open past the limit, add nothing", async () => {
    await using failed = await world({ mode: "fail" })
    await failed.claude.start()
    const first = await ok(failed.claude.addPlan, {})
    const attempt = await ok(failed.claude.addExecute, { nonce: first.nonce })
    // Evidence for a failure seen once under load (2.2.6-own.18 tier, not reproduced alone): the whole status and folder.
    const closed = await finished(failed, attempt.attemptID)
    if (closed.state !== "failed" || fs.existsSync(first.folder))
      console.error("login.test evidence (closed window)", JSON.stringify({ closed, folder: fs.existsSync(first.folder) }))
    expect(closed.state).toBe("failed")
    expect(fs.existsSync(first.folder)).toBe(false)

    // One window at a time. The open window keeps the long default limit, so a loaded PC that is slow to start the
    // fake CLI cannot time it out before the check; the world's end closes it.
    {
      await using open = await world({ mode: "hang" })
      await open.claude.start()
      const second = await ok(open.claude.addPlan, {})
      await ok(open.claude.addExecute, { nonce: second.nonce })
      const another = await ok(open.claude.addPlan, {})
      const refused = await call(open.claude.addExecute, { nonce: another.nonce })
      if (refused.ok) console.error("login.test evidence (second window)", JSON.stringify(refused))
      expect(refused).toMatchObject({
        ok: false,
        type: "claude_account_unavailable",
        data: { reason: "busy" },
      })
    }

    await using hung = await world({ mode: "hang", timeoutMs: 3_000 })
    await hung.claude.start()
    const third = await ok(hung.claude.addPlan, {})
    const waiting = await ok(hung.claude.addExecute, { nonce: third.nonce })
    const timedOut = await finished(hung, waiting.attemptID)
    if (timedOut.state !== "timeout") console.error("login.test evidence (hung window)", JSON.stringify(timedOut))
    expect(timedOut.state).toBe("timeout")
    expect(hung.registry.claudeAccounts ?? []).toEqual([])
  })

  test("no Claude Code on this PC, or a plugin that runs one account: nothing starts", async () => {
    await using w = await world({ cli: false })
    await w.claude.start()
    const plan = await ok(w.claude.addPlan, {})
    if (plan.cli === null) {
      expect(await call(w.claude.addExecute, { nonce: plan.nonce })).toMatchObject({
        ok: false,
        type: "claude_account_unavailable",
        data: { reason: "cli_missing" },
      })
      expect(fs.existsSync(plan.folder)).toBe(false)
    }
    await using single = await world({ multi: false })
    await single.claude.start()
    expect(await call(single.claude.addPlan, {})).toMatchObject({
      ok: false,
      type: "claude_account_unavailable",
      data: { reason: "not_patched" },
    })
  })

  test("detect: the slot's folder and its masked e-mail, without opening the credentials", async () => {
    await using w = await world()
    await w.claude.start()
    expect(await ok(w.claude.detect, {})).toEqual({ found: null, imported: false })
    login(path.join(w.home, ".claude"), { token: "fake-1", email: "person@example.test" })
    w.connection.value = { type: "credential", id: "c", label: "x", method: "oauth" }
    expect(await ok(w.claude.detect, {})).toEqual({
      found: { folder: path.join(w.home, ".claude"), email: "pe***@…" },
      imported: true,
    })
  })

  test("the window's environment is an allowlist plus the login folder", () => {
    const env = ClaudeLogin.environment("C:\\folder", {
      PATH: "p",
      SystemRoot: "s",
      ANTHROPIC_API_KEY: "secret",
      CLAUDE_CODE_OAUTH_TOKEN: "secret",
      OPENCODE_SERVER_PASSWORD: "secret",
      OWN_HOME: "h",
      USERPROFILE: "u",
    })
    expect<Record<string, string>>(env).toEqual({
      PATH: "p",
      SystemRoot: "s",
      USERPROFILE: "u",
      CLAUDE_CONFIG_DIR: "C:\\folder",
    })
  })
})

// CS (2026-10-22): `다시 로그인` on account 1 while it is Claude Code's own `%USERPROFILE%\.claude` (the temp profile's
// here) never logs into that folder: account 1 moves to a login folder of its own (`own 전용 로그인으로 바꾸기`).
describe("own 전용 로그인으로 바꾸기", () => {
  /** What a fake credentials file and profile hold, and when they were written, to show nothing touched them. */
  const snapshot = (folder: string) =>
    [".credentials.json", ".claude.json"].map((name) => {
      const file = path.join(folder, name)
      return { name, text: fs.readFileSync(file, "utf8"), mtimeMs: fs.statSync(file).mtimeMs }
    })

  test("account 1 moves to a new own folder; its id, label, color and bindings stay; Claude Code's folder is untouched", async () => {
    await using w = await world()
    // The same Claude account as the login the window makes (the fake CLI's `uuid-new`).
    const shared = login(path.join(w.home, ".claude"), { token: "fake-cc", uuid: "uuid-new", email: "me@example.test" })
    const before = snapshot(shared)
    await w.peers().slots.mutate((current) => ({
      ...current,
      claudeSlot: { accountID: "acc_claude_slot", label: "AC-01", shortLabel: "C1", color: "teal" },
    }))
    await w.claude.start()
    const slot = Account.ID.claudeSlot
    await ok(w.claude.sessionSet, { sessionID: "ses_bound" as never, accountID: slot })
    const plan = await ok(w.claude.addPlan, { accountID: slot })
    expect(plan.move).toBe(true)
    expect(path.dirname(plan.folder)).toBe(w.deps.runtime.layout.claudeAccounts)
    expect(path.basename(plan.folder).startsWith("acc_")).toBe(true)
    // The fake plugin holds a login of the new folder once the list names it (as the patched one does).
    w.fake.accounts[ClaudeLogin.key(plan.folder)] = "tok-own"
    const { attemptID } = await ok(w.claude.addExecute, { nonce: plan.nonce })
    expect(await finished(w, attemptID)).toEqual({ state: "added", accountID: slot, label: "AC-01" })
    expect(w.registry.claudeSlot).toEqual({
      accountID: "acc_claude_slot",
      label: "AC-01",
      shortLabel: "C1",
      color: "teal",
      configDir: plan.folder,
    })
    expect(w.registry.claudeAccounts ?? []).toEqual([])
    expect(w.claude.entry(slot)).toMatchObject({ configDir: plan.folder, key: ClaudeLogin.key(plan.folder) })
    const listed = JSON.parse(fs.readFileSync(path.join(w.stateDir, "claude-accounts.json"), "utf8"))
    expect(listed.accounts).toEqual([{ key: ClaudeLogin.key(plan.folder), configDir: plan.folder, label: "AC-01" }])
    // The bound conversation keeps account 1 and is now signed with the new folder's login.
    expect(await w.claude.onHttpRequest(request("ses_bound"))).toBe(slot)
    expect(w.fake.bound["ses_bound"]).toBe(ClaudeLogin.key(plan.folder))
    const view = w.claude
      .views({ verified: true, version: "0.4.0-fake" }, { windows: () => [], summary: () => ({ worst: null }) })
      .find((item) => item.id === slot)!
    expect(view).toMatchObject({ status: "ready", label: "AC-01", color: "teal", claude: { managed: true } })
    expect(view.claude?.shared).toBeUndefined()
    // The login window ran in the new folder, never in Claude Code's.
    expect(fs.existsSync(path.join(plan.folder, "env.json"))).toBe(true)
    expect(fs.existsSync(path.join(shared, "env.json"))).toBe(false)
    expect(snapshot(shared)).toEqual(before)
    // A later `다시 로그인` logs into the account's own folder again.
    const again = await ok(w.claude.addPlan, { accountID: slot })
    expect(again.folder).toBe(plan.folder)
    expect(again.move).toBeUndefined()
    expect((await ok(w.claude.detect, {})).found?.folder).toBe(plan.folder)
  })

  test("a window closed without a login leaves account 1 where it was and removes the new folder", async () => {
    await using w = await world({ mode: "fail" })
    const shared = login(path.join(w.home, ".claude"), { token: "fake-cc" })
    const before = snapshot(shared)
    await w.claude.start()
    const plan = await ok(w.claude.addPlan, { accountID: Account.ID.claudeSlot })
    expect(plan.move).toBe(true)
    const { attemptID } = await ok(w.claude.addExecute, { nonce: plan.nonce })
    expect((await finished(w, attemptID)).state).toBe("failed")
    expect(fs.existsSync(plan.folder)).toBe(false)
    expect(w.claude.entry(Account.ID.claudeSlot)?.configDir).toBe(shared)
    expect(w.registry.claudeSlot?.configDir).toBeUndefined()
    expect(snapshot(shared)).toEqual(before)
  })

  test("a login of another account of this PC is refused as a duplicate; account 1 stays", async () => {
    await using w = await world({ mode: "dup" })
    login(path.join(w.home, ".claude"), { token: "fake-cc", uuid: "uuid-cc" })
    // Account 2 is the login the window signs into (uuid-1).
    await w.add("acc_01J9CLAUDETWO0000000000000", path.join(w.home, "two"), { accountUuid: "uuid-1" })
    await w.claude.start()
    const plan = await ok(w.claude.addPlan, { accountID: Account.ID.claudeSlot })
    const { attemptID } = await ok(w.claude.addExecute, { nonce: plan.nonce })
    expect(await finished(w, attemptID)).toEqual({
      state: "duplicate",
      accountID: Account.ID.make("acc_01J9CLAUDETWO0000000000000"),
    })
    expect(fs.existsSync(plan.folder)).toBe(false)
    expect(w.claude.entry(Account.ID.claudeSlot)?.configDir).toBe(path.join(w.home, ".claude"))
  })

  // Review finding 4: a move keeps account 1's id, bindings and history, so it must stay the same Claude account.
  test("a login of another Claude account than the shared one changes nothing (`mismatch`)", async () => {
    await using w = await world()
    const shared = login(path.join(w.home, ".claude"), { token: "fake-cc", uuid: "uuid-cc", email: "me@example.test" })
    const before = snapshot(shared)
    await w.claude.start()
    const slot = Account.ID.claudeSlot
    await ok(w.claude.sessionSet, { sessionID: "ses_kept" as never, accountID: slot })
    const plan = await ok(w.claude.addPlan, { accountID: slot })
    expect(plan.move).toBe(true)
    const { attemptID } = await ok(w.claude.addExecute, { nonce: plan.nonce })
    // The window signs into `uuid-new`, not Claude Code's `uuid-cc`.
    expect(await finished(w, attemptID)).toEqual({ state: "mismatch", accountID: slot })
    expect(fs.existsSync(plan.folder)).toBe(false)
    expect(w.registry.claudeSlot?.configDir).toBeUndefined()
    expect(w.registry.claudeAccounts ?? []).toEqual([])
    expect(w.claude.entry(slot)).toMatchObject({ configDir: shared, readOnly: true })
    expect(await w.claude.onHttpRequest(request("ses_kept"))).toBe(slot)
    expect(w.fake.bound["ses_kept"]).toBe(ClaudeLogin.key(shared))
    expect(snapshot(shared)).toEqual(before)
    // Adding it as an account of its own instead is the ordinary `Claude 계정 추가`.
    const add = await ok(w.claude.addPlan, {})
    expect(add.move).toBeUndefined()
  })
})

// Review finding 13 (2026-10-11): no login lands, or stays, in a folder nothing registers.
describe("login folders nothing registers", () => {
  test("a window still open when the service stops is closed and its folder removed", async () => {
    await using w = await world({ mode: "hang" })
    await w.claude.start()
    const plan = await ok(w.claude.addPlan, {})
    const { attemptID } = await ok(w.claude.addExecute, { nonce: plan.nonce })
    // The fake CLI started and is waiting in its window.
    for (let index = 0; index < 200 && !fs.existsSync(path.join(plan.folder, "env.json")); index++) await Bun.sleep(25)
    expect(fs.existsSync(path.join(plan.folder, "env.json"))).toBe(true)
    await w.claude.stop()
    expect(fs.existsSync(plan.folder)).toBe(false)
    expect((await ok(w.claude.addStatus, { attemptID })).state).toBe("failed")
  })

  test("a login folder an earlier service left behind is swept; registered and fresh folders stay", async () => {
    await using w = await world()
    const root = w.deps.runtime.layout.claudeAccounts
    const left = path.join(root, "acc_01J9LEFTBEHIND000000000000")
    const kept = path.join(root, "acc_01J9REGISTERED000000000000")
    const fresh = path.join(root, "acc_01J9FRESHLOGIN000000000000")
    login(left, { token: "fake-left" })
    login(fresh, { token: "fake-fresh" })
    await w.add("acc_01J9REGISTERED000000000000", kept)
    login(kept, { token: "fake-kept" })
    const old = new Date(Date.now() - 3_600_000)
    for (const folder of [left, kept]) fs.utimesSync(folder, old, old)
    await w.claude.start()
    for (let index = 0; index < 100 && fs.existsSync(left); index++) await Bun.sleep(20)
    expect(fs.existsSync(left)).toBe(false)
    expect(fs.existsSync(kept)).toBe(true)
    expect(fs.existsSync(fresh)).toBe(true)
  })
})
