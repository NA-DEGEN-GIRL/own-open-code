// Several Claude accounts (02 §8.7, 07 R4): the account list the patched plugin reads, per-conversation binding of
// trees and teams, fail-closed refusal on a one-account plugin, attribution, and removal. Fakes only.
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Model } from "@opencode/schema/model"
import { Account, Kv, Preset } from "@own/protocol"
import { ClaudeAccounts } from "../../src/claude/accounts.js"
import { ClaudeLogin } from "../../src/claude/login.js"
import { ClaudeBundle } from "../../src/plugins/bundle.js"
import { call, ok, recordEvents, until } from "../plugins/support.js"
import { request, world } from "./support.js"

const SLOT = Account.ID.claudeSlot
const TWO = Account.ID.make("acc_01J9CLAUDETWO0000000000000")
const THREE = Account.ID.make("acc_01J9CLAUDETHREE00000000000")

describe("the account list", () => {
  test("account 1 is the slot's own folder; the patched plugin reads keys and folders only", async () => {
    await using w = await world()
    const second = await w.add(TWO, path.join(w.home, "two"))
    await w.claude.start()
    await w.claude.sync()
    expect(w.claude.list().map((item) => item.accountID)).toEqual([SLOT, TWO])
    const base = path.join(w.home, ".claude")
    expect(w.claude.entry(SLOT)?.configDir).toBe(base)
    const file = JSON.parse(fs.readFileSync(path.join(w.stateDir, ClaudeBundle.ACCOUNTS_FILE), "utf8"))
    expect(file).toEqual({
      version: ClaudeBundle.LIST_VERSION,
      default: ClaudeLogin.key(base),
      // own's labels, for the plugin's refusals ("Claude 계정 AC-02의 로그인이 …"); Claude Code's own login is read only.
      accounts: [
        { key: ClaudeLogin.key(base), configDir: base, label: "Claude", readOnly: true },
        { key: second, configDir: path.join(w.home, "two"), label: "Claude 2" },
      ],
    })
    // `claude-auth.json` (8.7 계정 소스) moves account 1; a folder Claude Code uses too (CLAUDE_CONFIG_DIR), read only.
    const moved = path.join(w.home, "elsewhere")
    fs.writeFileSync(
      w.deps.runtime.layout.claudeAuth,
      JSON.stringify({ configDir: moved, setAt: "2026-10-10T00:00:00Z" }),
    )
    await w.setDefault(TWO)
    await w.claude.sync()
    const next = JSON.parse(fs.readFileSync(path.join(w.stateDir, ClaudeBundle.ACCOUNTS_FILE), "utf8"))
    expect(next.default).toBe(second)
    expect(next.accounts[0]).toEqual({ key: ClaudeLogin.key(moved), configDir: moved, label: "Claude", readOnly: true })
  })

  test("views: one Claude card per account, the default marked, a folder without a login needs a login", async () => {
    await using w = await world()
    await w.add(TWO, path.join(w.home, "two"), { email: "tw***@…" })
    await w.add(THREE, path.join(w.home, "three"))
    delete w.fake.accounts[ClaudeLogin.key(path.join(w.home, "three"))]
    w.fake.accounts[ClaudeLogin.key(path.join(w.home, ".claude"))] = "tok-1"
    await w.claude.start()
    const views = w.claude.views(
      { verified: true, version: "0.4.0-fake" },
      { windows: () => [], summary: () => ({ worst: null }) },
    )
    expect(views.map((view) => [view.id, view.label, view.status, view.claude?.default])).toEqual([
      [SLOT, "Claude", "ready", true],
      [TWO, "tw***@…", "ready", false],
      [THREE, "Claude 3", "needs_reauth", false],
    ])
    expect(views.every((view) => view.kind === "claude-sub" && view.providerID === "anthropic")).toBe(true)
  })

  test("views carry each account's uuid: an added one's record, account 1's folder (SK2 synced skills)", async () => {
    await using w = await world()
    await w.add(TWO, path.join(w.home, "two"), { accountUuid: "uuid-two" })
    await w.add(THREE, path.join(w.home, "three"))
    fs.mkdirSync(path.join(w.home, ".claude"), { recursive: true })
    fs.writeFileSync(
      path.join(w.home, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "one@example.test", accountUuid: "uuid-one" } }),
    )
    await w.claude.start()
    const views = w.claude.views(
      { verified: true, version: "0.4.0-fake" },
      { windows: () => [], summary: () => ({ worst: null }) },
    )
    expect(views.map((view) => [view.id, view.claude?.accountUuid ?? null])).toEqual([
      [SLOT, "uuid-one"],
      [TWO, "uuid-two"],
      [THREE, null],
    ])
  })
})

// CS (2026-10-22): account 1 on Claude Code's own `%USERPROFILE%\.claude` (here the temp profile's) is read only: the
// patched plugin never refreshes it, so once its token expired the account waits for Claude Code.
describe("Claude Code's own login", () => {
  const SLOT_VIEW = { verified: true, version: "0.4.0-fake" }
  const EXTRA = { windows: () => [], summary: () => ({ worst: null }) }

  test("is marked shared; an expired login is stale and not usable, fresh again once Claude Code refreshed it; clients are told", async () => {
    await using w = await world()
    const events = recordEvents(w.deps)
    await w.add(TWO, path.join(w.home, "two"))
    await w.claude.start()
    const key = ClaudeLogin.key(path.join(w.home, ".claude"))
    const view = (id: string) => w.claude.views(SLOT_VIEW, EXTRA).find((item) => item.id === id)!
    const told = () => events.filter((event) => event.name === "account.status").map((event) => event.payload)
    expect(view(SLOT)).toMatchObject({ status: "ready", claude: { shared: true, stale: false } })
    // An account in an own folder is never shared.
    expect(view(TWO).claude?.shared).toBeUndefined()
    // The token runs out (inside the plugin's one-minute margin).
    w.fake.expires[key] = w.clock.now() + 30_000
    expect(view(SLOT)).toMatchObject({ status: "needs_reauth", claude: { shared: true, stale: true, loaded: true } })
    expect(w.claude.usable(SLOT)).toBe(false)
    expect(w.claude.usable(TWO)).toBe(true)
    /**
     * One look of the leader's watch: the clock moves on, and the look read the plugin's logins again. Its announcement
     * follows that read in the same turn, before `until`'s next poll runs.
     */
    const look = async () => {
      const reads = w.fake.calls.accounts
      w.clock.advance(15_000)
      await until(() => w.fake.calls.accounts > reads)
    }
    await look()
    expect(told()).toMatchObject([{ accountID: SLOT, status: "needs_reauth", reason: "claude_shared_stale" }])
    // Claude Code refreshed its login: the plugin reports the new expiry, and the card is ready again.
    w.fake.expires[key] = w.clock.now() + 3_600_000
    expect(view(SLOT)).toMatchObject({ status: "ready", claude: { shared: true, stale: false } })
    expect(w.claude.usable(SLOT)).toBe(true)
    await look()
    // Told once: the next look has nothing new to say.
    await look()
    expect(told()).toHaveLength(2)
    expect(told()[1]).toMatchObject({ accountID: SLOT, status: "ready" })
  })

  test("a login Claude Code made after the start is picked up by the watch", async () => {
    await using w = await world()
    const key = ClaudeLogin.key(path.join(w.home, ".claude"))
    // Claude Code is signed out of its folder when the service starts.
    delete w.fake.accounts[key]
    await w.claude.start()
    const view = () => w.claude.views(SLOT_VIEW, EXTRA).find((item) => item.id === SLOT)!
    expect(view()).toMatchObject({ status: "needs_reauth", claude: { shared: true, stale: false, loaded: false } })
    w.fake.accounts[key] = "tok-1"
    w.clock.advance(15_000)
    await until(() => view().claude?.loaded === true)
    expect(view()).toMatchObject({ status: "ready", claude: { loaded: true } })
  })

  test("a stale account is no target of an automatic switch", async () => {
    await using w = await world()
    await w.claude.start()
    const key = ClaudeLogin.key(path.join(w.home, ".claude"))
    w.fake.expires[key] = w.clock.now() - 1
    expect(w.claude.usable(SLOT)).toBe(false)
    // Its conversations are still bound and signed by the plugin, which refuses them with the shared-login message.
    expect(await w.claude.onHttpRequest(request("ses_stale"))).toBe(SLOT)
    expect(w.fake.bound["ses_stale"]).toBe(key)
  })

  /** The plugin's account list as the leader wrote it. */
  const listed = (w: Awaited<ReturnType<typeof world>>) =>
    JSON.parse(fs.readFileSync(path.join(w.stateDir, ClaudeBundle.ACCOUNTS_FILE), "utf8")).accounts as Array<{
      key: string
      configDir: string
      label: string
      readOnly?: boolean
    }>

  // Review finding 1: own decides, not a path comparison in the plugin.
  test("account 1 on the folder `claude-auth.json` names is Claude Code's too: read only, and the list says so", async () => {
    await using w = await world()
    const profile = path.join(w.home, "cc-profile")
    fs.mkdirSync(profile, { recursive: true })
    fs.writeFileSync(
      w.deps.runtime.layout.claudeAuth,
      JSON.stringify({ configDir: profile, setAt: "2026-10-22T00:00:00Z" }),
    )
    w.fake.accounts[ClaudeLogin.key(profile)] = "tok-profile"
    const two = await w.add(TWO, path.join(w.home, "two"))
    await w.claude.start()
    expect(w.claude.entry(SLOT)).toMatchObject({ configDir: profile, readOnly: true, managed: false })
    expect(w.claude.entry(TWO)?.readOnly).toBe(false)
    expect(listed(w)).toEqual([
      { key: ClaudeLogin.key(profile), configDir: profile, label: "Claude", readOnly: true },
      { key: two, configDir: path.join(w.home, "two"), label: "Claude 2" },
    ])
    w.fake.expires[ClaudeLogin.key(profile)] = w.clock.now() - 1
    const view = w.claude.views(SLOT_VIEW, EXTRA).find((item) => item.id === SLOT)!
    expect(view).toMatchObject({ status: "needs_reauth", claude: { shared: true, stale: true } })
    // `다시 로그인` never logs into it: it plans the move to an own folder.
    expect((await ok(w.claude.addPlan, { accountID: SLOT })).move).toBe(true)
  })

  test("a junction to Claude Code's folder is Claude Code's: read only, never offered for deletion", async () => {
    await using w = await world()
    const shared = path.join(w.home, ".claude")
    fs.mkdirSync(shared, { recursive: true })
    const link = path.join(w.deps.runtime.layout.claudeAccounts, "acc_01J9CLAUDETWO0000000000000")
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(shared, link, "junction")
    // `add` makes the folder only when it is missing; the junction stays a junction.
    const two = await w.add(TWO, link)
    const three = await w.add(THREE, path.join(w.home, "three"))
    await w.claude.start()
    expect(w.claude.entry(TWO)?.readOnly).toBe(true)
    expect(w.claude.entry(THREE)?.readOnly).toBe(false)
    expect(listed(w).map((item) => [item.key, item.readOnly === true])).toEqual([
      [ClaudeLogin.key(shared), true],
      [two, true],
      [three, false],
    ])
    const view = w.claude.views(SLOT_VIEW, EXTRA).find((item) => item.id === TWO)!
    expect(view.claude).toMatchObject({ shared: true, stale: false })
    expect((await ok(w.claude.removePlan, { accountID: TWO })).deleteFolder).toEqual({ offered: false, default: false })
    expect((await ok(w.claude.removePlan, { accountID: THREE })).deleteFolder.offered).toBe(true)
    // Once the junction is gone, the next look of the watch sees an own folder again and the leader rewrites the list.
    fs.rmSync(link, { recursive: true, force: true })
    fs.mkdirSync(link)
    w.clock.advance(15_000)
    await until(
      () =>
        w.claude.entry(TWO)?.readOnly === false && listed(w).find((item) => item.key === two)?.readOnly === undefined,
    )
    expect(w.claude.entry(TWO)?.readOnly).toBe(false)
    expect(listed(w).find((item) => item.key === two)?.readOnly).toBeUndefined()
  })

  // CS re-review (b): a link at file level, and the folder the launcher exported as Claude Code's CLAUDE_CONFIG_DIR.
  test("a folder whose credentials file is a hard link of Claude Code's, and the service's CLAUDE_CONFIG_DIR, are read only", async () => {
    const configured = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "own-cc-config-")))
    try {
      await using w = await world({ claudeConfigDir: configured })
      const shared = path.join(w.home, ".claude")
      fs.mkdirSync(shared, { recursive: true })
      // Fake bytes: own never reads a credentials file, it only compares the file's identity.
      fs.writeFileSync(path.join(shared, ".credentials.json"), "{}")
      const linked = path.join(w.deps.runtime.layout.claudeAccounts, "acc_01J9CLAUDETWO0000000000000")
      fs.mkdirSync(linked, { recursive: true })
      fs.linkSync(path.join(shared, ".credentials.json"), path.join(linked, ".credentials.json"))
      const two = await w.add(TWO, linked)
      const three = await w.add(THREE, configured)
      await w.claude.start()
      expect([w.claude.entry(TWO)?.readOnly, w.claude.entry(THREE)?.readOnly]).toEqual([true, true])
      expect(listed(w).map((item) => [item.key, item.readOnly === true])).toEqual([
        [ClaudeLogin.key(shared), true],
        [two, true],
        [three, true],
      ])
      for (const accountID of [TWO, THREE]) {
        expect(w.claude.views(SLOT_VIEW, EXTRA).find((item) => item.id === accountID)?.claude?.shared).toBe(true)
        expect((await ok(w.claude.removePlan, { accountID })).deleteFolder.offered).toBe(false)
        expect((await ok(w.claude.addPlan, { accountID })).move).toBe(true)
      }
    } finally {
      fs.rmSync(configured, { recursive: true, force: true })
    }
  })

  // CS re-review (c): relogin or move, and whether a folder may be deleted, are decided on the folders as they are when
  // the call runs, not as the last 15 s look saw them.
  test("plan and execute read the folders again: a folder that became Claude Code's is moved to, never logged into or deleted", async () => {
    await using w = await world()
    const shared = path.join(w.home, ".claude")
    fs.mkdirSync(shared, { recursive: true })
    fs.writeFileSync(path.join(shared, ".credentials.json"), "{}")
    const folder = path.join(w.deps.runtime.layout.claudeAccounts, "acc_01J9CLAUDETWO0000000000000")
    await w.add(TWO, folder)
    await w.claude.start()
    expect(w.claude.entry(TWO)?.readOnly).toBe(false)
    const relogin = await ok(w.claude.addPlan, { accountID: TWO })
    expect(relogin.move).toBeUndefined()
    const removal = await ok(w.claude.removePlan, { accountID: TWO })
    expect(removal.deleteFolder.offered).toBe(true)
    // Between the plans and their execution (no watch ran), the folder turns into a junction to Claude Code's.
    fs.rmSync(folder, { recursive: true, force: true })
    fs.symlinkSync(shared, folder, "junction")
    expect(await call(w.claude.addExecute, { nonce: relogin.nonce })).toMatchObject({
      ok: false,
      type: "nonce_invalid",
    })
    expect(fs.existsSync(path.join(shared, "env.json"))).toBe(false)
    expect((await ok(w.claude.addPlan, { accountID: TWO })).move).toBe(true)
    expect(await ok(w.claude.removeExecute, { nonce: removal.nonce, deleteFolder: true })).toMatchObject({
      folderDeleted: false,
    })
    expect(fs.readFileSync(path.join(shared, ".credentials.json"), "utf8")).toBe("{}")
  })

  // CS re-review (a): the first start after an update finds the list an older own wrote (`version: 1`, no `readOnly`).
  test("no request is signed before the list of this version is on disk; a list that cannot be written refuses", async () => {
    await using w = await world()
    const file = path.join(w.stateDir, ClaudeBundle.ACCOUNTS_FILE)
    // An unwritable list (a file in place of its folder): the leader's write fails at start and again on the request.
    fs.rmSync(w.stateDir, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(w.stateDir), { recursive: true })
    fs.writeFileSync(w.stateDir, "")
    await w.claude.start()
    await expect(w.claude.onHttpRequest(request("ses_early"))).rejects.toThrow(
      "Claude 계정 목록을 아직 준비하지 못했어요 · 잠시 뒤 다시 시도해요. 계속 뜨면 서비스를 다시 시작해요. Claude 계정 Claude의 요청은 보내지 않았어요.",
    )
    expect(await w.claude.ready()).toBe(false)
    expect(w.fake.bound).toEqual({})
    expect(w.alerts.map((alert) => alert.code)).toEqual(["claude_account_refused"])
    // The next request writes it and goes.
    fs.rmSync(w.stateDir)
    expect(await w.claude.onHttpRequest(request("ses_early"))).toBe(SLOT)
    expect(JSON.parse(fs.readFileSync(file, "utf8")).version).toBe(ClaudeBundle.LIST_VERSION)
    // Another instance of the service (not the leader) signs only once the leader's list of this version is there.
    const other = ClaudeAccounts.make({ ...w.deps, runtime: { ...w.deps.runtime, isLeader: () => false } }, w.peers, {
      userHome: w.home,
      claudeConfigDir: undefined,
      login: w.login,
    })
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), version: 1 }))
    await expect(other.onHttpRequest(request("ses_other"))).rejects.toThrow("Claude 계정 목록을 아직 준비하지 못했어요")
    expect(w.fake.bound["ses_other"]).toBeUndefined()
    await w.claude.sync()
    expect(await other.onHttpRequest(request("ses_other"))).toBe(SLOT)
    expect(w.fake.bound["ses_other"]).toBe(ClaudeLogin.key(path.join(w.home, ".claude")))
  }, 30_000)
})

describe("binding a conversation (G2, R4)", () => {
  test("a new tree keeps the account it started on; subagents use their root's; the plugin is told before signing", async () => {
    await using w = await world()
    const two = await w.add(TWO, path.join(w.home, "two"))
    await w.claude.start()
    w.fake.accounts[ClaudeLogin.key(path.join(w.home, ".claude"))] = "tok-1"
    expect(await w.claude.onHttpRequest(request("ses_r1"))).toBe(SLOT)
    expect(w.storage.get(Kv.claudeSession("ses_r1"))).toMatchObject({ accountID: SLOT })
    // The default moves (the account chosen last): the running tree stays, a new tree takes it.
    await w.setDefault(TWO)
    expect(await w.claude.onHttpRequest(request("ses_r1"))).toBe(SLOT)
    expect(await w.claude.onHttpRequest(request("r2"))).toBe(TWO)
    expect(w.fake.bound["r2"]).toBe(two)
    // A subagent of r1 (the runtime index knows its parent) runs on r1's account.
    w.deps.runtime.sessions.update("c1", { parentID: "ses_r1" })
    expect(await w.claude.onHttpRequest(request("c1"))).toBe(SLOT)
    expect(w.fake.bound["c1"]).toBe(ClaudeLogin.key(path.join(w.home, ".claude")))
    // A grandchild known only to the session service.
    w.sessions.set("g1", { id: "g1", parentID: "c1" })
    expect(await w.claude.onHttpRequest(request("g1"))).toBe(SLOT)
  })

  test("PF 2026-11-03: a tree without an account starts on the one its preset pins, while it can sign and has room", async () => {
    // A ChatGPT preset whose model pool pins Claude account 3 (`Claude 구독 [AC-03 ▾]` in the editor).
    const pinned: Preset.Info = {
      id: Preset.ID.make("pr_01J9PFC4AD0000000000000000"),
      name: "Claude 3 리뷰",
      group: "codex",
      workers: {
        mode: "same",
        roles: {},
        pool: [{ key: "claude-opus-5-5", model: Model.ID.make("claude-opus-5-5"), account: THREE }],
      },
      delegation: "model",
      caps: Preset.CAPS,
      ultraCaps: null,
      revision: 1,
    }
    await using w = await world({ preset: (id) => (id === pinned.id ? pinned : undefined) })
    await w.add(TWO, path.join(w.home, "two"))
    await w.add(THREE, path.join(w.home, "three"), { shortLabel: "C3" })
    await w.claude.start()
    const bind = (root: string) =>
      w.storage.set(Kv.preset(root), {
        presetID: pinned.id,
        group: "codex",
        revision: 1,
        appliedAt: 0,
        entryHash: null,
      })
    bind("ses_pf1")
    // The default is account 1; the preset names account 3, so the tree starts there, and its subagent follows.
    expect(await w.claude.onHttpRequest(request("ses_pf1"))).toBe(THREE)
    w.deps.runtime.sessions.update("ses_pf1_child", { parentID: "ses_pf1" })
    expect(await w.claude.onHttpRequest(request("ses_pf1_child"))).toBe(THREE)
    // A tree that already runs on another account keeps it (one Claude account per tree, 07 R4).
    await w.claude.onHttpRequest(request("ses_pf2"))
    bind("ses_pf2")
    expect(await w.claude.onHttpRequest(request("ses_pf2"))).toBe(SLOT)
    // An account that ran out is not started on: the default instead.
    w.deps.runtime.limits.exhaust({
      accountID: THREE,
      windowId: "claude.5h",
      until: w.deps.clock.now() + 3_600_000,
      class: "hard",
    })
    bind("ses_pf3")
    expect(await w.claude.onHttpRequest(request("ses_pf3"))).toBe(SLOT)
  })

  test("the switcher moves the whole tree, and new conversations follow the account chosen last", async () => {
    await using w = await world()
    await w.add(TWO, path.join(w.home, "two"))
    await w.claude.start()
    await w.claude.onHttpRequest(request("ses_root"))
    w.deps.runtime.sessions.update("ses_child", { parentID: "ses_root" })
    const moved = await ok(w.claude.sessionSet, { sessionID: "ses_child" as never, accountID: TWO as never })
    expect(moved.accountID).toBe(TWO)
    expect(moved.sessions.map(String).sort()).toEqual(["ses_child", "ses_root"])
    expect(await w.claude.onHttpRequest(request("ses_root"))).toBe(TWO)
    expect(await w.claude.onHttpRequest(request("ses_child"))).toBe(TWO)
    expect(w.registry.claudeDefault).toBe(TWO)
    expect(await ok(w.claude.sessionGet, { sessionID: "ses_child" as never })).toEqual({ accountID: TWO, bound: true })
    expect(
      (await call(w.claude.sessionSet, { sessionID: "ses_root" as never, accountID: "acc_nope" as never })).ok,
    ).toBe(false)
  })

  test("a team runs on one Claude account: switching one member moves every member", async () => {
    await using w = await world()
    await w.add(TWO, path.join(w.home, "two"))
    await w.claude.start()
    await w.team("main", "tm_one")
    await w.team("owner", "tm_one")
    await w.team("solo", "tm_two")
    expect(await w.claude.onHttpRequest(request("main"))).toBe(SLOT)
    await ok(w.claude.sessionSet, { sessionID: "owner" as never, accountID: TWO as never })
    expect(w.storage.get(Kv.claudeTeam("tm_one"))).toMatchObject({ accountID: TWO })
    expect(await w.claude.onHttpRequest(request("main"))).toBe(TWO)
    expect(await w.claude.onHttpRequest(request("owner"))).toBe(TWO)
    // Another team keeps its own.
    expect(await w.claude.onHttpRequest(request("solo"))).toBe(TWO)
    await ok(w.claude.sessionSet, { sessionID: "solo" as never, accountID: SLOT })
    expect(await w.claude.onHttpRequest(request("main"))).toBe(TWO)
  })

  test("a one-account plugin refuses a conversation bound to another account; nothing is signed", async () => {
    await using w = await world({ multi: false })
    await w.add(TWO, path.join(w.home, "two"))
    await w.claude.start()
    expect(w.claude.multi()).toBe(false)
    // Unbound: the plugin's single account, and no binding is written.
    expect(await w.send("plain")).toBe(SLOT)
    expect(w.storage.has(Kv.claudeSession("plain"))).toBe(false)
    w.storage.set(Kv.claudeSession("other"), { accountID: TWO, at: 0 })
    expect(w.claude.onHttpRequest(request("other"))).rejects.toThrow("요청을 보내지 않았습니다")
    await Bun.sleep(0)
    // The plain conversation was the slot's first request (02 §8.9); the refused one sent nothing.
    expect(w.alerts.map((alert) => alert.code)).toEqual(["claude_first_request", "claude_account_refused"])
    expect(w.fake.bound).toEqual({})
    // The switcher refuses another account too.
    const refused = await call(w.claude.sessionSet, { sessionID: "plain" as never, accountID: TWO as never })
    expect(refused).toMatchObject({ ok: false, type: "claude_account_unavailable", data: { reason: "not_patched" } })
  })

  test("a binding to an account that is gone fails closed", async () => {
    await using w = await world()
    await w.claude.start()
    w.storage.set(Kv.claudeSession("lost"), { accountID: THREE, at: 0 })
    expect(w.claude.onHttpRequest(request("lost"))).rejects.toThrow("요청을 보내지 않았습니다")
  })

  test("attribution: the account that signed a request, from the plugin, mapped to the own account (G4)", async () => {
    await using w = await world()
    const two = await w.add(TWO, path.join(w.home, "two"))
    await w.claude.start()
    await w.claude.onHttpRequest(request("x"))
    const prepared = new Request("http://127.0.0.1:9/v1/messages", { method: "POST", body: "{}" })
    w.fake.signed.set(prepared, two)
    expect(w.deps.runtime.claude.accountOf(prepared)).toBe(TWO)
    expect(w.deps.runtime.claude.accountOf(new Request("http://127.0.0.1:9/"))).toBeUndefined()
  })
})

describe("removing an account", () => {
  test("its conversations move to the default account; an own folder may go, the user's never", async () => {
    await using w = await world()
    const folder = path.join(w.home, "two")
    await w.add(TWO, folder)
    await w.add(THREE, path.join(w.home, ".claude-other"), { managed: false })
    await w.claude.start()
    await ok(w.claude.sessionSet, { sessionID: "ses_r1" as never, accountID: TWO as never })
    w.deps.runtime.sessions.update("ses_r1child", { parentID: "ses_r1" })
    await w.team("ses_teammain", "tm_gone")
    await ok(w.claude.sessionSet, { sessionID: "ses_teammain" as never, accountID: TWO as never })
    const plan = await ok(w.claude.removePlan, { accountID: TWO as never })
    expect(plan.boundSessions.map(String).sort()).toEqual(["ses_r1", "ses_teammain"])
    expect(plan.deleteFolder).toEqual({ offered: true, default: true })
    expect((await ok(w.claude.removePlan, { accountID: THREE as never })).deleteFolder).toEqual({
      offered: false,
      default: false,
    })
    expect((await call(w.claude.removePlan, { accountID: SLOT })).ok).toBe(false)
    const done = await ok(w.claude.removeExecute, { nonce: plan.nonce, deleteFolder: true })
    expect(done.folderDeleted).toBe(true)
    expect(fs.existsSync(folder)).toBe(false)
    expect(done.movedSessions.map(String)).toContain("ses_r1")
    expect(w.registry.claudeAccounts?.map((item) => item.accountID)).toEqual([THREE])
    expect(w.registry.claudeDefault).toBeUndefined()
    // A team bound to the removed account moves too (its members follow the team's binding).
    expect(w.storage.get(Kv.claudeTeam("tm_gone"))).toMatchObject({ accountID: SLOT })
    expect(await w.claude.onHttpRequest(request("ses_r1child"))).toBe(SLOT)
  })
})

// Regressions of the review of 2026-10-11 (the finding numbers of that review).
describe("review fixes", () => {
  test("finding 2: a module that carries the patch but is not verified as patched runs account 1 only", async () => {
    for (const patch of ["modified"] as const) {
      await using w = await world()
      await w.add(TWO, path.join(w.home, "two"))
      await w.setDefault(TWO)
      w.patch.state = patch
      await w.claude.start()
      expect(w.claude.multi()).toBe(false)
      // Unbound: account 1, named to the plugin, never the list's default; no binding is written.
      expect(await w.claude.onHttpRequest(request("u1"))).toBe(SLOT)
      expect(w.fake.bound["u1"]).toBe(ClaudeLogin.key(path.join(w.home, ".claude")))
      expect(w.storage.has(Kv.claudeSession("u1"))).toBe(false)
      w.storage.set(Kv.claudeSession("b2"), { accountID: TWO, at: 0 })
      expect(w.claude.onHttpRequest(request("b2"))).rejects.toThrow("요청을 보내지 않았습니다")
      await Bun.sleep(0)
      expect(w.fake.bound["b2"]).toBeUndefined()
      const refused = await call(w.claude.sessionSet, { sessionID: "u1" as never, accountID: TWO as never })
      expect(refused).toMatchObject({ ok: false, type: "claude_account_unavailable" })
    }
  })

  test("finding 17: an account the plugin holds no login of is refused, never signed by a fallback", async () => {
    await using w = await world()
    const two = await w.add(TWO, path.join(w.home, "two"))
    await w.claude.start()
    await ok(w.claude.sessionSet, { sessionID: "ses_nologin" as never, accountID: TWO as never })
    delete w.fake.accounts[two]
    expect(w.claude.onHttpRequest(request("ses_nologin"))).rejects.toThrow("로그인이 없습니다")
    await Bun.sleep(0)
    expect(w.fake.bound["ses_nologin"]).toBeUndefined()
    expect(w.alerts.map((alert) => [alert.code, alert.accountID])).toEqual([["claude_account_refused", TWO]])
  })

  test("finding 18: claude-auth's hook before own's is refused until the order is fixed", async () => {
    await using w = await world()
    await w.claude.start()
    w.patch.order = "before_own_accounts"
    expect(w.claude.onHttpRequest(request("early"))).rejects.toThrow("요청을 보내지 않았습니다")
    await Bun.sleep(0)
    expect(w.fake.bound["early"]).toBeUndefined()
    w.patch.order = "ok"
    expect(await w.claude.onHttpRequest(request("early"))).toBe(SLOT)
  })

  test("finding 16: a failed read fails the request and never replaces the stored binding", async () => {
    await using w = await world()
    await w.add(TWO, path.join(w.home, "two"))
    await w.claude.start()
    w.storage.set(Kv.claudeSession("ses_kept"), { accountID: TWO, at: 0 })
    w.failing.add(Kv.claudeSession("ses_kept"))
    expect(w.claude.onHttpRequest(request("ses_kept"))).rejects.toThrow("reading")
    await Bun.sleep(0)
    expect(w.storage.get(Kv.claudeSession("ses_kept"))).toMatchObject({ accountID: TWO })
    w.failing.delete(Kv.claudeSession("ses_kept"))
    expect(await w.claude.onHttpRequest(request("ses_kept"))).toBe(TWO)
    // A subagent whose parent cannot be read is not run as a tree of its own.
    w.failing.add("ses_orphan")
    expect(w.claude.onHttpRequest(request("ses_orphan"))).rejects.toThrow("reading")
    await Bun.sleep(0)
    expect(w.storage.has(Kv.claudeSession("ses_orphan"))).toBe(false)
  })

  test("findings 9 and 15: a team formed after its sessions ran settles on one account, whoever asks first", async () => {
    for (const first of ["ses_lead", "ses_member"] as const) {
      await using w = await world()
      await w.add(TWO, path.join(w.home, "two"))
      await w.claude.start()
      // The lead ran alone on account 2; later the user picked account 1 elsewhere (the default).
      await ok(w.claude.sessionSet, { sessionID: "ses_lead" as never, accountID: TWO as never })
      expect(await w.claude.onHttpRequest(request("ses_lead"))).toBe(TWO)
      await w.setDefault(undefined)
      // own.team adopts the lead into a team and starts a member.
      await w.team("ses_lead", "tm_late")
      await w.team("ses_member", "tm_late")
      const other = first === "ses_lead" ? "ses_member" : "ses_lead"
      expect(await w.claude.onHttpRequest(request(first))).toBe(TWO)
      expect(await w.claude.onHttpRequest(request(other))).toBe(TWO)
      expect(w.storage.get(Kv.claudeTeam("tm_late"))).toMatchObject({ accountID: TWO })
      // Moving the team moves the lead's own binding too, so it never signs with the old account later.
      await ok(w.claude.sessionSet, { sessionID: "ses_member" as never, accountID: SLOT })
      expect(w.storage.get(Kv.claudeSession("ses_lead"))).toMatchObject({ accountID: SLOT })
      expect(await w.claude.onHttpRequest(request("ses_lead"))).toBe(SLOT)
      expect(await w.claude.onHttpRequest(request("ses_member"))).toBe(SLOT)
    }
  })

  test("findings 9 and 15: a root that joins a team on another account follows the team's account", async () => {
    await using w = await world()
    await w.add(TWO, path.join(w.home, "two"))
    await w.claude.start()
    await ok(w.claude.sessionSet, { sessionID: "ses_solo" as never, accountID: TWO as never })
    expect(await w.claude.onHttpRequest(request("ses_solo"))).toBe(TWO)
    // The team's context names account 1: the team runs on it, and the joining root moves with a notice.
    await w.team("ses_solo", "tm_named", [SLOT])
    const bound: Array<{ sessionIDs: ReadonlyArray<string>; accountID: string }> = []
    const off = w.deps.runtime.broadcast.on("claude.bound", (change) => bound.push(change))
    expect(await w.claude.onHttpRequest(request("ses_solo"))).toBe(SLOT)
    off()
    expect(w.storage.get(Kv.claudeTeam("tm_named"))).toMatchObject({ accountID: SLOT })
    expect(w.storage.get(Kv.claudeSession("ses_solo"))).toMatchObject({ accountID: SLOT })
    expect(bound).toEqual([{ sessionIDs: ["ses_solo"], accountID: SLOT }])
  })

  test("finding 14: a remote service pins a new tree on its first request and refuses a binding its mirror lacks", async () => {
    const view = {
      state: "enabled",
      fast: false,
      display: { label: null, shortLabel: "C", color: "orange" },
      accounts: [
        { accountID: SLOT, label: null, shortLabel: "C", color: "orange", default: true, usable: true },
        { accountID: TWO, label: null, shortLabel: "C2", color: "amber", default: false, usable: true },
      ],
    }
    // The account the relay's proof named for the request (the PC signs with it), as the remote host reports it.
    const relayed: { accountID?: string } = {}
    await using w = await world({ remote: { claude: () => view, claudeSigner: () => relayed.accountID } })
    /** One relayed request and its answer. */
    const send = async (sessionID: string) => {
      const event = request(sessionID)
      relayed.accountID = await w.claude.onHttpRequest(event)
      await w.claude.onHttpResponse({ ...event, response: new Response("{}") })
      return relayed.accountID
    }
    await w.claude.start()
    expect(await send("ses_r1")).toBe(SLOT)
    expect(w.storage.get(Kv.claudeSession("ses_r1"))).toMatchObject({ accountID: SLOT })
    // The PC's default moves: the running tree keeps its account, a new one takes the new default.
    view.accounts = view.accounts.map((item) => ({ ...item, default: item.accountID === TWO }))
    expect(await send("ses_r1")).toBe(SLOT)
    expect(await send("ses_r2")).toBe(TWO)
    // The host's scope drops account 2: its conversation is refused, never signed as the default.
    view.accounts = [{ ...view.accounts[0]!, default: true }]
    expect(w.claude.onHttpRequest(request("ses_r2"))).rejects.toThrow("요청을 보내지 않았습니다")
    await Bun.sleep(0)
    // A remote service remembers each account's first request too (02 §8.9).
    expect(w.alerts.map((alert) => [alert.code, alert.accountID])).toEqual([
      ["claude_first_request", SLOT],
      ["claude_first_request", TWO],
      ["claude_account_refused", TWO],
    ])
  })
})

// 02 §8.9 (CW, 2026-10-19): the composer's notice of an account's first request, remembered per account on the service.
describe("the first request on a Claude account", () => {
  test("is announced once per account, for the tree's root, and remembered across a restart", async () => {
    await using w = await world()
    await w.add(TWO, path.join(w.home, "two"))
    await w.claude.start()
    w.deps.runtime.sessions.update("ses_child", { parentID: "ses_root" })
    expect(await w.send("ses_child")).toBe(SLOT)
    expect(w.alerts).toEqual([
      {
        code: "claude_first_request",
        severity: "warning",
        sessionID: "ses_root",
        accountID: SLOT,
        message: "이 계정의 첫 Claude 요청이에요 · 추가 사용량으로 청구될 수 있어요",
      },
    ])
    expect(w.storage.get(Kv.claudeFirstRequest(SLOT))).toEqual({ at: w.clock.now(), sessionID: "ses_root" })
    // The same account again, from another conversation: nothing.
    await w.send("ses_root")
    await w.send("ses_other")
    expect(w.alerts).toHaveLength(1)
    // Another account's first request is its own.
    await ok(w.claude.sessionSet, { sessionID: "ses_two" as never, accountID: TWO as never })
    expect(await w.send("ses_two")).toBe(TWO)
    expect(w.alerts.map((alert) => [alert.code, alert.accountID, alert.sessionID])).toEqual([
      ["claude_first_request", SLOT, "ses_root"],
      ["claude_first_request", TWO, "ses_two"],
    ])
    // A new instance on the same service (a restart) reads the record and stays quiet.
    const again = ClaudeAccounts.make(w.deps, w.peers, { userHome: w.home, claudeConfigDir: undefined, login: w.login })
    await again.start()
    const later = request("ses_later")
    await again.onHttpRequest(later)
    await again.onHttpResponse({ ...later, response: new Response("{}") })
    await again.stop()
    expect(w.alerts).toHaveLength(2)
  })

  test("a failed read of the record never refuses the request; the next request tries again", async () => {
    await using w = await world()
    await w.claude.start()
    w.failing.add(Kv.claudeFirstRequest(SLOT))
    expect(await w.send("ses_a")).toBe(SLOT)
    expect(w.alerts).toEqual([])
    w.failing.delete(Kv.claudeFirstRequest(SLOT))
    expect(await w.send("ses_b")).toBe(SLOT)
    expect(w.alerts.map((alert) => [alert.code, alert.sessionID])).toEqual([["claude_first_request", "ses_b"]])
  })

  test("a refused request is no first request", async () => {
    await using w = await world()
    await w.claude.start()
    w.storage.set(Kv.claudeSession("lost"), { accountID: THREE, at: 0 })
    expect(w.claude.onHttpRequest(request("lost"))).rejects.toThrow("요청을 보내지 않았습니다")
    await Bun.sleep(0)
    expect(w.storage.has(Kv.claudeFirstRequest(THREE))).toBe(false)
    expect(w.alerts.map((alert) => alert.code)).toEqual(["claude_account_refused"])
  })

  // CR (2026-10-26): AC-02 and AC-03 showed the notice on their first use although the plugin refused the request (its
  // login could not be refreshed) and nothing was sent; the notice was then remembered as shown.
  test("a request the plugin refused after own bound it is no first request; the first answer is", async () => {
    await using w = await world()
    await w.add(TWO, path.join(w.home, "two"))
    await w.claude.start()
    await ok(w.claude.sessionSet, { sessionID: "ses_two" as never, accountID: TWO as never })
    // own's hook bound it; the plugin's hook then threw (no answer, no `http.response`).
    expect(await w.claude.onHttpRequest(request("ses_two"))).toBe(TWO)
    expect(w.alerts).toEqual([])
    expect(w.storage.has(Kv.claudeFirstRequest(TWO))).toBe(false)
    expect(await w.send("ses_two")).toBe(TWO)
    expect(w.alerts.map((alert) => [alert.code, alert.accountID])).toEqual([["claude_first_request", TWO]])
    expect(w.storage.has(Kv.claudeFirstRequest(TWO))).toBe(true)
  })
})

// CR (2026-10-26): the card's refresh line of an account the plugin refreshes (never Claude Code's own login), from
// what the plugin says: its last failed refresh, else `due` while the access token expired and nothing was tried.
describe("a Claude account's refresh line (CR)", () => {
  const SLOT_VIEW = { verified: true, version: "0.4.0-fake" }
  const EXTRA = { windows: () => [], summary: () => ({ worst: null }) }

  test("follows the plugin: failed asks for 다시 로그인, retrying stays ready, an expired one never tried is due", async () => {
    await using w = await world()
    const events = recordEvents(w.deps)
    const two = await w.add(TWO, path.join(w.home, "two"), { label: "AC-02" })
    await w.claude.start()
    const view = () => w.claude.views(SLOT_VIEW, EXTRA).find((item) => item.id === TWO)!
    expect(view().claude?.refresh).toBeUndefined()
    // The access token expired; the plugin has not tried to refresh it: ready, the first request refreshes it.
    w.fake.expires[two] = w.clock.now() - 1_000
    w.clock.advance(15_000)
    await until(() => view().claude?.refresh?.state === "due")
    expect(view().status).toBe("ready")
    expect(w.claude.usable(TWO)).toBe(true)
    const listener = w.fake.listener!
    const base = { key: two, label: "Claude Max", trigger: "expiry" }
    listener({ type: "started", ...base, expiresAt: w.clock.now() - 1_000 })
    listener({
      type: "failed",
      ...base,
      kind: "transient",
      status: 429,
      ms: 80,
      error: "rate_limit_error",
      retryAfterMs: 30_000,
      retryAt: w.clock.now() + 30_000,
    })
    expect(view()).toMatchObject({
      status: "ready",
      claude: {
        refresh: { state: "retrying", status: 429, error: "rate_limit_error", retryAt: w.clock.now() + 30_000 },
      },
    })
    listener({
      type: "failed",
      ...base,
      kind: "terminal",
      status: 400,
      ms: 90,
      error: "invalid_grant",
      description: "Refresh token [token] is not valid",
    })
    expect(view()).toMatchObject({
      status: "needs_reauth",
      claude: { refresh: { state: "failed", status: 400, error: "invalid_grant" } },
    })
    expect(w.claude.usable(TWO)).toBe(false)
    // Every refresh is a log line with what the endpoint said, the account's id and own's label.
    const lines = w.logs.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines.filter((line) => String(line.msg).match(/^claude_refresh_(started|ok|failed)$/))).toMatchObject([
      { scope: "test.claude", msg: "claude_refresh_started", accountID: TWO, label: "AC-02", trigger: "expiry" },
      { msg: "claude_refresh_failed", level: "warn", kind: "transient", status: 429, retryAfterMs: 30_000 },
      {
        msg: "claude_refresh_failed",
        kind: "terminal",
        status: 400,
        description: "Refresh token [token] is not valid",
      },
    ])
    // The clients were told each time (their accounts page reads the list again).
    expect(
      events
        .filter((event) => event.name === "account.status" && event.payload.reason === "claude_refresh")
        .map((event) => event.payload.status),
    ).toEqual(["ready", "ready", "needs_reauth"])
    // A refresh that worked ends it.
    listener({ type: "ok", ...base, ms: 70, expiresAt: w.clock.now() + 3_600_000, rotated: true })
    expect(view()).toMatchObject({ status: "ready" })
    expect(view().claude?.refresh).toBeUndefined()
  })

  test("Claude Code's own login has no refresh line: it is never refreshed here", async () => {
    await using w = await world()
    await w.claude.start()
    w.fake.expires[ClaudeLogin.key(path.join(w.home, ".claude"))] = w.clock.now() - 1_000
    w.clock.advance(15_000)
    const view = () => w.claude.views(SLOT_VIEW, EXTRA).find((item) => item.id === SLOT)!
    await until(() => view().claude?.stale === true)
    expect(view().claude?.refresh).toBeUndefined()
  })
})
