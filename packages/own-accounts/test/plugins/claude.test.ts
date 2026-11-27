// The Claude subscription plugin that ships inside the app (02 §8.2, user decision 2026-10-18 "넣고 항상 켜기"): the
// pinned template that builds it, detection and verification of the bundle in this Location's plugin list, status, the
// retired consent and install jobs, billing and the account source change. Fake bundles only.
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Plugin } from "@own/protocol"
import { ClaudeBundle } from "../../src/plugins/bundle.js"
import { Claude } from "../../src/plugins/claude.js"
import { Inventory } from "../../src/plugins/inventory.js"
import { Notice } from "../../src/plugins/notice.js"
import { builtIn } from "../../src/rpc/plugins.js"
import { FAKE_PATCH_SHA256 } from "../support/fake-claude-auth.js"
import { FAKE_PIN, call, configText, local, ok, sessionEvent, until, world } from "./support.js"

const SPEC_INTEGRITY = "sha512-dVA2AY58JxrZP3QqetevB3yebwQLVoMGyBFrPbJPDdCgJ94UEzQpK9/5Jk0Ibeyeom5mWD/HInaJgfX9O5MljA=="
const TEMPLATE = path.resolve(import.meta.dir, "..", "..", "..", "..", "own", "vendor", "claude-auth")
const OAUTH = { type: "credential", id: "crd_1", label: "Claude Max · someone@example.com", method: "oauth" } as const

describe("the pinned build input (own/vendor/claude-auth)", () => {
  test("the lock pins the version and integrity of 02 §8.1 and the plugin SDK the host provides", async () => {
    const manifest = await Bun.file(path.join(TEMPLATE, "package.json")).json()
    expect(manifest).toEqual({
      private: true,
      type: "module",
      dependencies: { "opencode-claude-auth-v2": "0.4.0-beta.5" },
      overrides: { "@opencode/plugin": "2.0.24" },
    })
    const locked = await Bun.file(path.join(TEMPLATE, "package-lock.json")).json()
    expect(locked.packages["node_modules/opencode-claude-auth-v2"]).toMatchObject({
      version: "0.4.0-beta.5",
      integrity: SPEC_INTEGRITY,
      dependencies: { "@opencode/plugin": "latest" },
    })
    expect(locked.packages["node_modules/@opencode/plugin"]).toMatchObject({
      version: manifest.overrides["@opencode/plugin"],
      integrity: expect.stringMatching(/^sha512-/),
    })
  })

  test("the patch manifest names exactly the locked version and integrity", async () => {
    const patch = await Bun.file(path.join(TEMPLATE, "patches", "0.4.0-beta.5.json")).json()
    expect(patch).toMatchObject({
      schema: 1,
      package: Plugin.CLAUDE_AUTH_PACKAGE,
      version: "0.4.0-beta.5",
      integrity: SPEC_INTEGRITY,
      marker: ClaudeBundle.MARKER,
    })
    expect(patch.files.map((file: { file: string }) => file.file)).toContain("dist/keychain.js")
  })

  test("masks emails in connection labels", () => {
    expect(Claude.maskEmail("Claude Max · person@example.com")).toBe("Claude Max · pe***@…")
    expect(Claude.connection({ type: "env", name: "ANTHROPIC_API_KEY" })).toEqual({
      type: "env",
      label: "ANTHROPIC_API_KEY",
    })
    expect(
      Claude.connection({ type: "credential", id: "crd_1", label: "Claude Pro · ab@c.io", method: "oauth" }),
    ).toEqual({ type: "oauth", method: "claude-code", label: "Claude Pro · ab***@…" })
  })
})

describe("plugin.claudeAuth.status (02 §8.2)", () => {
  test("a build without the bundle: absent, bundle_missing, anthropic stays disabled", async () => {
    await using w = await world()
    await w.plugins.start()
    expect(await ok(w.plugins.claudeAuthStatus, {})).toEqual({
      installed: false,
      version: null,
      integrityOk: null,
      order: "missing",
      phase: "absent",
      acknowledged: null,
      connection: null,
      warnings: ["bundle_missing"],
      patch: { state: "no_manifest", sha256: null, loaded: false },
      bundle: null,
      remote: { acknowledged: null, noticeHash: Notice.REMOTE_HASH, hosts: [] },
    })
    expect(w.plugins.claudeSlot()).toEqual({ detected: false, version: null, integrity: null, verified: false })
  })

  test("the bundle loaded: verified with no consent, patched, its record reported; a connection makes it ready", async () => {
    await using w = await world()
    w.bundle()
    await w.plugins.start()
    expect(w.plugins.claudeSlot()).toEqual({
      detected: true,
      version: FAKE_PIN.version,
      integrity: FAKE_PIN.integrity,
      verified: true,
    })
    expect(w.plugins.claudeOrder()).toBe("ok")
    expect(await ok(w.plugins.claudeAuthStatus, {})).toMatchObject({
      installed: true,
      version: FAKE_PIN.version,
      integrityOk: true,
      order: "ok",
      phase: "installed",
      acknowledged: null,
      warnings: [],
      patch: { state: "patched", sha256: FAKE_PATCH_SHA256, loaded: true },
      bundle: {
        version: FAKE_PIN.version,
        integrity: FAKE_PIN.integrity,
        patchSha256: FAKE_PATCH_SHA256,
        buildId: null,
      },
    })
    w.connection = OAUTH
    expect(await ok(w.plugins.claudeAuthStatus, {})).toMatchObject({
      phase: "ready",
      connection: { type: "oauth", method: "claude-code", label: "Claude Max · so***@…" },
    })
    w.connection = { type: "env", name: "ANTHROPIC_API_KEY" }
    expect((await ok(w.plugins.claudeAuthStatus, {})).warnings).toEqual(["claude_slot_billing"])
  })

  test("the shipped bundle not in this Location's list: not_loaded", async () => {
    await using w = await world({ config: configText({ accounts: "x", telemetry: "y" }) })
    w.bundle()
    await w.plugins.start()
    const status = await ok(w.plugins.claudeAuthStatus, {})
    expect(status).toMatchObject({ installed: true, version: FAKE_PIN.version, phase: "installed", order: "missing" })
    expect(status.warnings).toEqual(["not_loaded"])
    expect(w.plugins.claudeSlot()).toMatchObject({ detected: false, verified: false })
  })

  test("a bundle file changed afterwards is an integrity mismatch: the slot is blocked", async () => {
    await using w = await world()
    w.bundle()
    await w.plugins.start()
    expect(w.plugins.claudeSlot().verified).toBe(true)
    await fs.appendFile(
      path.join(w.bundleDir, "node_modules", Plugin.CLAUDE_AUTH_PACKAGE, "dist", "index.js"),
      "// edit\n",
    )
    await w.plugins.refreshed()
    const status = await ok(w.plugins.claudeAuthStatus, {})
    expect(status.patch?.state).toBe("modified")
    expect(status.integrityOk).toBe(false)
    expect(status.warnings).toContain("integrity_mismatch")
    expect(w.plugins.claudeSlot().verified).toBe(false)
  })

  test("a claude-auth that is not the app's bundle (the former npm install) is blocked: not_bundled", async () => {
    await using w = await world()
    w.bundle({ multi: true, record: false })
    await w.plugins.start()
    const status = await ok(w.plugins.claudeAuthStatus, {})
    expect(status.patch?.state).toBe("modified")
    expect(status.warnings).toEqual(expect.arrayContaining(["not_bundled", "integrity_mismatch"]))
    expect(w.plugins.claudeSlot()).toMatchObject({ detected: true, verified: false })
  })

  test("a verified bundle whose loaded module lacks the multi-account exports asks for a restart", async () => {
    await using w = await world()
    w.bundle({ multi: false })
    await w.plugins.start()
    const status = await ok(w.plugins.claudeAuthStatus, {})
    expect(status.patch).toEqual({ state: "patched", sha256: FAKE_PATCH_SHA256, loaded: false })
    expect(status.warnings).toEqual(["patch_restart"])
  })

  test("the module own loads is told the stable state folder (02 §8.7)", async () => {
    await using w = await world()
    w.bundle()
    await w.plugins.start()
    const fake = (await import(path.join(w.bundleDir, "node_modules", Plugin.CLAUDE_AUTH_PACKAGE, "dist", "index.js")))
      .fake as { stateDir: string | null }
    expect(fake.stateDir).toBe(w.stateDir)
    expect(w.plugins.stateDir).toBe(path.join(w.deps.runtime.layout.thirdparty, "claude-auth"))
  })
})

describe("retired consent and jobs (2026-10-18)", () => {
  test("ack answers and stores nothing; install, uninstall and patch are refused as built in", async () => {
    await using w = await world()
    w.bundle()
    await w.plugins.start()
    const acked = await ok(w.plugins.claudeAuthAck, {
      version: FAKE_PIN.version,
      integrity: FAKE_PIN.integrity,
      noticeHash: "0".repeat(64),
    })
    expect(acked.acknowledgedAt).toBe(new Date(w.clock.now()).toISOString())
    expect([...w.storage.keys()]).toEqual([])
    for (const method of [
      builtIn<"plugin.claudeAuth.install.plan">(),
      builtIn<"plugin.claudeAuth.uninstall.plan">(),
      builtIn<"plugin.claudeAuth.patch.plan">(),
    ])
      expect(await call(method, {})).toMatchObject({
        ok: false,
        type: "internal_error",
        message: expect.stringContaining("built_in"),
      })
  })
})

describe("billing and the account source", () => {
  test("an env or key connection raises claude_slot_billing once", async () => {
    await using w = await world()
    w.bundle()
    await w.plugins.start()
    const deliver = async () => {
      w.plugins.onEvent?.(
        sessionEvent("credential.switched", { integrationID: "anthropic", credentialID: null }, w.workspace),
        { local: true },
      )
      await until(() => w.alerts.length > 0 || w.connection === undefined)
      await Bun.sleep(5)
    }
    w.connection = { type: "env", name: "ANTHROPIC_API_KEY" }
    await deliver()
    await deliver()
    expect(w.alerts.map((alert) => [alert.code, alert.severity, alert.accountID])).toEqual([
      ["claude_slot_billing", "danger", "acc_claude_slot"],
    ])
  })

  test("changeSource needs the loaded plugin, refuses while a session runs and hands the restart to the client", async () => {
    await using w = await world()
    await w.plugins.start()
    expect(await call(w.plugins.changeSourcePlan, { configDir: w.root })).toMatchObject({
      ok: false,
      type: "plugin_not_installed",
    })
    w.bundle()
    await w.plugins.refreshed()
    const source = path.join(w.root, "claude-config")
    await fs.mkdir(source, { recursive: true })
    await Bun.write(path.join(source, ".credentials.json"), "{}")
    const sid = "ses_running_1"
    w.plugins.onEvent?.(sessionEvent("session.execution.started", { sessionID: sid }), { local: false })
    const plan = await ok(w.plugins.changeSourcePlan, { configDir: source })
    expect(plan).toMatchObject({ runningSessions: [sid], credentialsFound: true, restartRequired: true })
    expect(await call(w.plugins.changeSourceExecute, { nonce: plan.nonce })).toMatchObject({
      ok: false,
      type: "session_busy",
      data: { sessionIDs: [sid] },
    })
    w.plugins.onEvent?.(sessionEvent("session.execution.succeeded", { sessionID: sid }), { local: false })
    const again = await ok(w.plugins.changeSourcePlan, { configDir: source })
    expect(again.runningSessions).toEqual([])
    expect(await ok(w.plugins.changeSourceExecute, { nonce: again.nonce })).toEqual({
      clientAction: { type: "restart-service" },
    })
    // v0.4 (02 §8.7): the source is in OWN_HOME\claude-auth.json before the client restarts the service.
    const claudeAuth = w.deps.runtime.layout.claudeAuth
    expect(JSON.parse(await Bun.file(claudeAuth).text())).toMatchObject({ configDir: source })
    const empty = await ok(w.plugins.changeSourcePlan, { configDir: path.join(w.root, "nowhere") })
    expect(empty.credentialsFound).toBe(false)
    expect(await call(w.plugins.changeSourcePlan, { configDir: "relative\\dir" })).toMatchObject({
      ok: false,
      type: "setting_out_of_range",
      data: { field: "configDir" },
    })
    // `null` goes back to the default source: the file is removed.
    const reset = await ok(w.plugins.changeSourcePlan, { configDir: null })
    await ok(w.plugins.changeSourceExecute, { nonce: reset.nonce })
    expect(await Bun.file(claudeAuth).exists()).toBe(false)
  })

  // CS (2026-10-22): account 1 on an own login folder (`claudeSlot.configDir`) would ignore the source; it is refused,
  // and going back to a folder Claude Code uses (read only) happens only when the caller says so.
  test("changeSource after the move to an own login is refused; `leaveOwnLogin` goes back explicitly", async () => {
    await using w = await world()
    w.bundle()
    await w.plugins.start()
    await w.plugins.refreshed()
    const claudeAuth = w.deps.runtime.layout.claudeAuth
    const source = path.join(w.root, "claude-profile")
    const own = path.join(w.deps.runtime.layout.claudeAccounts, "acc_01J9OWNLOGIN000000000000000")
    const move = async () => {
      w.registry = await w.deps.runtime.registry.update((current) => ({
        ...current,
        claudeSlot: { accountID: "acc_claude_slot", label: "AC-01", shortLabel: "C1", color: "teal", configDir: own },
      }))
    }
    // A plan made before the move is not executed after it either.
    const early = await ok(w.plugins.changeSourcePlan, { configDir: source })
    await move()
    for (const configDir of [source, null])
      expect(await call(w.plugins.changeSourcePlan, { configDir })).toMatchObject({
        ok: false,
        type: "claude_account_unavailable",
        data: { reason: "own_login" },
      })
    expect(await call(w.plugins.changeSourceExecute, { nonce: early.nonce })).toMatchObject({
      ok: false,
      type: "claude_account_unavailable",
      data: { reason: "own_login" },
    })
    expect(await Bun.file(claudeAuth).exists()).toBe(false)
    expect(w.registry.claudeSlot?.configDir).toBe(own)
    // Asked in so many words: the source is written and account 1 leaves its own folder (label and color stay).
    const leave = await ok(w.plugins.changeSourcePlan, { configDir: source, leaveOwnLogin: true })
    expect(await ok(w.plugins.changeSourceExecute, { nonce: leave.nonce })).toEqual({
      clientAction: { type: "restart-service" },
    })
    expect(JSON.parse(await Bun.file(claudeAuth).text())).toMatchObject({ configDir: source })
    expect(w.registry.claudeSlot).toEqual({
      accountID: "acc_claude_slot",
      label: "AC-01",
      shortLabel: "C1",
      color: "teal",
    })
    // Without an own folder the flag changes nothing more.
    const plain = await ok(w.plugins.changeSourcePlan, { configDir: null, leaveOwnLogin: true })
    await ok(w.plugins.changeSourceExecute, { nonce: plain.nonce })
    expect(await Bun.file(claudeAuth).exists()).toBe(false)
    expect(w.registry.claudeSlot?.label).toBe("AC-01")
  })

  // CS re-review (h): one of own's login folders as the source would be exported as Claude Code's CLAUDE_CONFIG_DIR and
  // turn read only, so its account would stop at the next expiry.
  test("changeSource never takes one of own's login folders, by path or through a junction, with or without leaveOwnLogin", async () => {
    await using w = await world()
    w.bundle()
    await w.plugins.start()
    await w.plugins.refreshed()
    const claudeAuth = w.deps.runtime.layout.claudeAuth
    const own = path.join(w.deps.runtime.layout.claudeAccounts, "acc_01J9OWNLOGIN000000000000000")
    await fs.mkdir(own, { recursive: true })
    const junction = path.join(w.root, "looks-like-a-profile")
    await fs.symlink(own, junction, "junction")
    const refused = { ok: false, type: "setting_out_of_range", data: { field: "configDir" } }
    for (const input of [
      { configDir: own },
      { configDir: own.toUpperCase() },
      { configDir: junction },
      { configDir: own, leaveOwnLogin: true },
    ])
      expect(await call(w.plugins.changeSourcePlan, input)).toMatchObject(refused)
    // A plan for a plain folder that turned into a junction to an own folder before execute is out of date.
    const later = path.join(w.root, "later")
    await fs.mkdir(later)
    const plan = await ok(w.plugins.changeSourcePlan, { configDir: later })
    await fs.rm(later, { recursive: true })
    await fs.symlink(own, later, "junction")
    expect(await call(w.plugins.changeSourceExecute, { nonce: plan.nonce })).toMatchObject({
      ok: false,
      type: "nonce_invalid",
    })
    expect(await Bun.file(claudeAuth).exists()).toBe(false)
  })

  // 02 §8.10.2 (CAG): a folder belongs to one route. The Claude Agent route's folders are its own: claude-auth's source
  // would make a second refresher of the login claude itself keeps fresh there.
  test("changeSource never takes a Claude Agent account folder, by path or through a junction", async () => {
    await using w = await world()
    w.bundle()
    await w.plugins.start()
    await w.plugins.refreshed()
    const agent = path.join(w.deps.runtime.layout.claudeAgent, "accounts", "acc_01J9AGENTLOGIN00000000000")
    await fs.mkdir(agent, { recursive: true })
    const junction = path.join(w.root, "agent-profile")
    await fs.symlink(agent, junction, "junction")
    const refused = { ok: false, type: "setting_out_of_range", data: { field: "configDir" } }
    for (const input of [{ configDir: agent }, { configDir: agent.toUpperCase() }, { configDir: junction }])
      expect(await call(w.plugins.changeSourcePlan, input)).toMatchObject(refused)
    expect(await Bun.file(w.deps.runtime.layout.claudeAuth).exists()).toBe(false)
  })
})

describe("claude-auth detection", () => {
  test("follows plugin.updated: detected only while active, order reported", async () => {
    await using w = await world({ config: configText({ accounts: "x", telemetry: "y" }) })
    const entry = w.bundle()
    const accounts = local("own.accounts", path.join(w.own.accounts, "index.js"))
    const telemetry = local("own.telemetry", path.join(w.own.telemetry, "index.js"))
    const claude = local(Plugin.CLAUDE_AUTH_ID, entry)
    w.override = { entries: [accounts, telemetry, claude] }
    await w.plugins.start()
    expect(w.plugins.claudeSlot().detected).toBe(true)
    expect(w.plugins.claudeOrder()).toBe("after_own_telemetry")
    const reloads = w.reloads.count

    w.override = { entries: [accounts, telemetry] }
    w.plugins.onEvent?.(sessionEvent("plugin.updated", {}, w.workspace), { local: true })
    await ok(w.plugins.claudeAuthStatus, {})
    expect(w.plugins.claudeSlot().detected).toBe(false)
    expect(w.plugins.claudeOrder()).toBe("missing")
    expect(w.reloads.count).toBe(reloads + 1)

    // A list that predates this instance's generation (no active own.accounts) is ignored.
    w.override = { entries: [claude] }
    w.plugins.onEvent?.(sessionEvent("plugin.updated", {}, w.workspace), { local: true })
    await ok(w.plugins.claudeAuthStatus, {})
    expect(w.plugins.claudeSlot().detected).toBe(false)
  })

  test("claude-auth active before own.team is reported as before_own_team (06 §2.6)", async () => {
    await using w = await world({ config: configText({ accounts: "x", telemetry: "y" }) })
    const accounts = local("own.accounts", path.join(w.own.accounts, "index.js"))
    const team = local("own.team", path.join(w.own.root, "own-team", "index.js"))
    const telemetry = local("own.telemetry", path.join(w.own.telemetry, "index.js"))
    const claude = local(Plugin.CLAUDE_AUTH_ID, w.bundle())
    w.override = { entries: [accounts, claude, team] }
    await w.plugins.start()
    expect(w.plugins.claudeOrder()).toBe("before_own_team")
    // own.team and the bundle load from the own plugin folder, so neither blocks the Location.
    expect(w.plugins.trustStatus()).toBe("ok")

    w.override = { entries: [accounts, team, claude, telemetry] }
    w.plugins.onEvent?.(sessionEvent("plugin.updated", {}, w.workspace), { local: true })
    await ok(w.plugins.claudeAuthStatus, {})
    expect(w.plugins.claudeOrder()).toBe("ok")

    // before_own_accounts still wins over before_own_team.
    w.override = { entries: [claude, accounts, team, telemetry] }
    w.plugins.onEvent?.(sessionEvent("plugin.updated", {}, w.workspace), { local: true })
    await ok(w.plugins.claudeAuthStatus, {})
    expect(w.plugins.claudeOrder()).toBe("before_own_accounts")
  })

  test("a claude-auth folder that failed to load is still recognised by its name; an active plugin only by its id", () => {
    const failed = local(undefined, path.resolve("/own/app/2.0.28-own.1/plugins/claude-auth"), "failed")
    expect(Inventory.isClaude(failed)).toBe(true)
    expect(Inventory.isClaude(local(undefined, path.resolve("/project/.opencode/plugins/claude-auth/index.js")))).toBe(
      false,
    )
    expect(Inventory.isClaude(local(Plugin.CLAUDE_AUTH_ID, path.resolve("/anywhere/server.js")))).toBe(true)
  })

  test("own-team is an own package: a source run trusts packages/own-team even before it exists", () => {
    expect(Inventory.OWN_PACKAGES).toEqual([
      "own-accounts",
      "own-remote",
      "own-team",
      "own-telemetry",
      "own-computer-use",
      "own-import",
      "own-harness",
      "own-omo",
      "own-creator",
    ])
    const packages = path.resolve(import.meta.dir, "..", "..", "..")
    const roots = Inventory.ownRoots({ root: path.resolve("/nowhere"), app: path.resolve("/nowhere/app/current") })
    expect(roots).toContain(path.join(packages, "own-team"))
    expect(roots).toContain(path.join(packages, "own-computer-use"))
    expect(roots).toContain(path.join(packages, "own-import"))
    expect(roots).toContain(path.join(packages, "own-harness"))
    expect(roots).toContain(path.join(packages, "own-omo"))
    expect(roots).toContain(path.join(packages, "own-creator"))
  })

  test("the bundle folder: the installed version's; a source run also trusts the bundle script's output", () => {
    const app = path.resolve("/own/app/2.0.28-own.1")
    expect(ClaudeBundle.dir(app)).toBe(path.join(app, "plugins", "claude-auth"))
    expect(ClaudeBundle.devDir("/own/app/2.0.28-own.1/plugins/own-accounts/index.js")).toBeUndefined()
    expect(ClaudeBundle.devDir()?.replaceAll("\\", "/")).toEndWith("own/.out/claude-auth")
    expect(ClaudeBundle.stateDir(path.resolve("/own/thirdparty"))).toBe(path.resolve("/own/thirdparty/claude-auth"))
  })
})
