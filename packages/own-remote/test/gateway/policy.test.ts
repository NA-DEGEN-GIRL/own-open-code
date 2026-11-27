// The gateway's allow list (05 §13.4–13.5): every upstream route has an explicit rule, RPC follows the protocol
// scope tables (own.accounts, own.remote, own.team — a host's team on /srv/<hostId> too, 06 §2.7 T3 — and own.import,
// on this PC only, with its I2 scopes, 09 §5.5 IG11, and own.harness on every server, 10 §6.1), `always` permission
// replies and `local` methods never pass, the own.computer rule stays at status + Stop on this PC only, app-listener
// devices (08) get the same decisions as browsers, and the event filter drops `local` frames, undeclared plugin events
// and frames of servers the device may not see.
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Notes, OwnAccounts, Voice } from "@own/protocol"
import { OwnComputer } from "@own/protocol/rpc-computer"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { OwnImportRouting } from "@own/protocol/rpc-import-routing"
import { OwnTeamRouting } from "@own/protocol/rpc-team-routing"
import { Devices } from "../../src/gateway/devices.js"
import { Policy } from "../../src/gateway/policy.js"
import { OwnRemote } from "../../src/protocol/rpc-remote.js"

const OPENAPI = path.resolve(import.meta.dir, "../../../protocol/openapi.json")
const ALL = new Set(OwnRemote.DEVICE_SCOPES)
const PHONE = new Set(OwnRemote.DEFAULT_DEVICE_SCOPES)
const READ = new Set(["read"])

function upstreamRoutes() {
  const spec = JSON.parse(fs.readFileSync(OPENAPI, "utf8")) as { paths: Record<string, Record<string, unknown>> }
  return Object.entries(spec.paths).flatMap(([route, operations]) =>
    Object.keys(operations)
      .filter((method) => ["get", "post", "put", "patch", "delete"].includes(method))
      .map((method) => ({ method: method.toUpperCase(), route, sample: route.replace(/\{[^}]+\}/g, "x1") })),
  )
}

describe("route allow list", () => {
  test("every route of packages/protocol/openapi.json has an explicit rule (an upstream addition fails closed)", () => {
    const routes = upstreamRoutes()
    expect(routes.length).toBeGreaterThan(100)
    const missing = routes.filter(({ method, sample }) => {
      const match = Policy.classify(method, sample.replace("/*", "/some/file.ts"))
      return match.need.kind === "blocked" && match.need.reason === "not_allowlisted"
    })
    expect(missing.map((route) => `${route.method} ${route.route}`)).toEqual([])
  })

  test("unknown routes and traversal are refused", () => {
    expect(Policy.classify("GET", "/api/new-upstream-thing").need).toEqual({ kind: "blocked", reason: "not_allowlisted" })
    expect(Policy.classify("GET", "/api/session//x").need.kind).toBe("blocked")
    expect(Policy.classify("PUT", "/api/session").need.kind).toBe("blocked")
  })

  test("always-blocked paths stay blocked with every scope (05 §13.4)", () => {
    for (const [method, route] of [
      ["POST", "/api/pair"],
      ["POST", "/api/credential/c1/activate"],
      ["PATCH", "/api/credential/c1"],
      ["GET", "/api/integration"],
      ["POST", "/api/integration/i1/connect/key"],
      ["POST", "/api/location/reload"],
      ["PATCH", "/api/experimental/config"],
      ["POST", "/api/plugin/update"],
      ["POST", "/api/experimental/persistent-pty/handoff"],
      // Mints a realtime voice session with a server-stored OpenAI or xAI key (upstream d4a6223d01).
      ["POST", "/api/experimental/voice/session"],
      // Upstream v2.2's routes own-web does not use (05 §13.4).
      ["POST", "/api/debug/heap-dump"],
      ["GET", "/api/plugin/gui"],
      ["GET", "/api/experimental/voice/models"],
      ["GET", "/api/experimental/client-mcp"],
      ["POST", "/api/experimental/client-mcp/token"],
      ["POST", "/api/experimental/generate/text"],
      ["POST", "/api/experimental/generate/image"],
      ["POST", "/api/experimental/generate/decisions"],
      // Upstream v2.4's routes (automations replace v2.2's schedules; videos, blobs, machines, job cancel; MR18).
      ["POST", "/api/experimental/generate/video"],
      ["GET", "/api/experimental/generate/video/vid_1"],
      ["POST", "/api/experimental/automation"],
      ["GET", "/api/experimental/automation"],
      ["GET", "/api/experimental/automation/aut_1"],
      ["DELETE", "/api/experimental/automation/aut_1"],
      ["POST", "/api/experimental/automation/aut_1/pause"],
      ["POST", "/api/experimental/automation/aut_1/resume"],
      ["GET", "/api/experimental/blob/blb_1"],
      ["GET", "/api/experimental/machine/link"],
      ["GET", "/api/experimental/machine"],
      ["POST", "/api/experimental/machine"],
      ["DELETE", "/api/experimental/machine/gpu"],
      ["POST", "/api/experimental/job/job_1/cancel"],
      ["GET", "/api/experimental/usage/limits"],
      ["GET", "/api/experimental/job"],
      ["GET", "/api/experimental/media/abc"],
      ["POST", "/api/experimental/fs/watch"],
      ["DELETE", "/api/experimental/fs/watch"],
    ] as const) {
      const match = Policy.classify(method, route)
      const decision = Policy.decide({ need: match.need, params: match.params, scopes: ALL, server: "local" })
      expect({ route, ok: decision.ok }).toEqual({ route, ok: false })
    }
  })

  test("literal routes win over parameters", () => {
    expect(Policy.classify("GET", "/api/session/active").template).toBe("/api/session/active")
    expect(Policy.classify("GET", "/api/session/ses_1").template).toBe("/api/session/:sessionID")
    expect(Policy.classify("POST", "/api/experimental/persistent-pty/shutdown").need.kind).toBe("blocked")
  })

  test("scope table of 05 §13.5: read, prompt, files, terminal, admin", () => {
    const check = (method: string, route: string, scopes: ReadonlySet<string>) => {
      const match = Policy.classify(method, route)
      return Policy.decide({ need: match.need, params: match.params, scopes, server: "local" }).ok
    }
    expect(check("GET", "/api/session", READ)).toBe(true)
    expect(check("GET", "/api/event", READ)).toBe(true)
    expect(check("POST", "/api/session/s1/prompt", READ)).toBe(false)
    expect(check("POST", "/api/session/s1/prompt", PHONE)).toBe(true)
    expect(check("POST", "/api/session/s1/interrupt", PHONE)).toBe(true)
    // Context reset and its undo (core P-035, 03 §18.18): prompt, like compact.
    expect(check("POST", "/api/session/s1/reset", PHONE)).toBe(true)
    expect(check("DELETE", "/api/session/s1/reset/msg_1", PHONE)).toBe(true)
    expect(check("POST", "/api/session/s1/reset", READ)).toBe(false)
    expect(check("DELETE", "/api/session/s1/reset/msg_1", READ)).toBe(false)
    expect(check("GET", "/api/fs/list", PHONE)).toBe(false)
    expect(check("GET", "/api/fs/read/src/a.ts", new Set(["files"]))).toBe(true)
    expect(check("POST", "/api/pty", PHONE)).toBe(false)
    expect(check("POST", "/api/pty", new Set(["terminal"]))).toBe(true)
    expect(check("POST", "/api/session/s1/shell", PHONE)).toBe(false)
    expect(check("GET", "/api/config", PHONE)).toBe(false)
    expect(check("DELETE", "/api/session/s1", PHONE)).toBe(false)
    expect(check("DELETE", "/api/session/s1", new Set(["admin"]))).toBe(true)
    // Changing a saved "always allow" rule (upstream v2.2) is admin, like listing and removing them.
    expect(check("PATCH", "/api/permission/saved/p1", PHONE)).toBe(false)
    expect(check("PATCH", "/api/permission/saved/p1", new Set(["admin"]))).toBe(true)
  })

  test("permission reply: once and reject with prompt; always never (01 §13.4)", () => {
    const match = Policy.classify("POST", "/api/session/s1/permission/p1/reply")
    const decide = (body: unknown, scopes: ReadonlySet<string> = PHONE) =>
      Policy.decide({ need: match.need, params: match.params, scopes, server: "local", body }).ok
    expect(decide({ decision: "once" })).toBe(true)
    expect(decide({ decision: "reject" })).toBe(true)
    expect(decide({ decision: "always" })).toBe(false)
    expect(decide({ decision: "always" }, ALL)).toBe(false)
    expect(decide({})).toBe(false)
    expect(decide({ decision: "once" }, READ)).toBe(false)
  })

  test("session.update cannot write permissions from a device", () => {
    const match = Policy.classify("PATCH", "/api/session/s1")
    const decide = (body: unknown) => Policy.decide({ need: match.need, params: match.params, scopes: ALL, server: "local", body }).ok
    expect(decide({ title: "x" })).toBe(true)
    expect(decide({ permissions: [] })).toBe(false)
  })

  test("a device never stamps own.import's helper marker, which hides a session and has the next start delete it", () => {
    const helper = { "own.import": { v: 1, helper: true, jobID: "job_x" } }
    const update = (body: unknown) => {
      const match = Policy.classify("PATCH", "/api/session/s1")
      return Policy.decide({ need: match.need, params: match.params, scopes: ALL, server: "local", body })
    }
    expect(update({ metadata: helper })).toEqual({ ok: false, status: 403, type: "scope_denied", scope: "local" })
    // own-web's pin and archive flags write the whole metadata back, an imported conversation's `own.import` too.
    expect(update({ metadata: { "own.web": { pinned: true } } }).ok).toBe(true)
    expect(update({ metadata: { "own.import": { v: 1, kind: "codex", mode: "full" }, "own.web": {} } }).ok).toBe(true)
    expect(update({ metadata: { "own.import": { v: 1, helper: false } } }).ok).toBe(true)
    const create = (route: string, body: unknown, scopes: ReadonlySet<string>) => {
      const match = Policy.classify("POST", route)
      return Policy.decide({ need: match.need, params: match.params, scopes, server: "local", body }).ok
    }
    expect(create("/api/session", { title: "x", metadata: helper }, PHONE)).toBe(false)
    expect(create("/api/session", { title: "x", metadata: { "own.web": {} } }, PHONE)).toBe(true)
    expect(create("/api/experimental/session/import", { info: { metadata: helper }, messages: [] }, ALL)).toBe(false)
    expect(create("/api/experimental/session/import", { info: { metadata: {} }, messages: [] }, ALL)).toBe(true)
  })

  test("a device cannot create or import a session whose rules allow computer use (01 §10.2: only on the PC)", () => {
    const create = (body: unknown, scopes: ReadonlySet<string> = PHONE) => {
      const match = Policy.classify("POST", "/api/session")
      return Policy.decide({ need: match.need, params: match.params, scopes, server: "local", body })
    }
    const allow = { action: "computer", resource: "*", effect: "allow" }
    expect(create({ title: "x" }).ok).toBe(true)
    // own-web on a phone creates sessions with the browser deny.
    expect(create({ permissions: [{ action: "browser", resource: "*", effect: "deny" }] }).ok).toBe(true)
    expect(create({ permissions: [allow] })).toEqual({ ok: false, status: 403, type: "scope_denied", scope: "local" })
    expect(create({ permissions: [allow] }, ALL).ok).toBe(false)
    // Wildcards and asks that match `computer` would list the tools too.
    expect(create({ permissions: [{ action: "*", resource: "*", effect: "allow" }] }).ok).toBe(false)
    expect(create({ permissions: [{ action: "COMP*", resource: "*", effect: "ask" }] }).ok).toBe(false)
    expect(create({ permissions: [allow] }, READ)).toMatchObject({ ok: false, scope: "prompt" })
    expect(Policy.needsBody(Policy.classify("POST", "/api/session").need)).toBe(true)

    const imported = (body: unknown, scopes: ReadonlySet<string>) => {
      const match = Policy.classify("POST", "/api/experimental/session/import")
      return Policy.decide({ need: match.need, params: match.params, scopes, server: "local", body }).ok
    }
    expect(imported({ info: { permissions: [] }, messages: [] }, new Set(["admin"]))).toBe(true)
    expect(imported({ info: { permissions: [allow] }, messages: [] }, new Set(["admin"]))).toBe(false)
    expect(imported({ info: { permissions: [] }, messages: [] }, PHONE)).toBe(false)
  })

  test("a device's new session carries no rules of its own: the mode comes from session.approval.set (RL5-4)", () => {
    const create = (body: unknown, scopes: ReadonlySet<string> = PHONE) => {
      const match = Policy.classify("POST", "/api/session")
      return Policy.decide({ need: match.need, params: match.params, scopes, server: "local", body })
    }
    const deny = { action: "browser", resource: "*", effect: "deny" }
    // What own-web sends: no rules, or the browser deny of a window without the pane; the agent by name.
    for (const permissions of [undefined, null, [], [deny], [deny, deny]])
      expect(create({ title: "x", agent: "build", permissions }).ok).toBe(true)
    // Anything else stays on the PC, even for a device with every scope: allows, asks and other denies alike.
    for (const rule of [
      { action: "edit", resource: "*", effect: "allow" },
      { action: "bash", resource: "rm *", effect: "allow" },
      { action: "browser", resource: "*", effect: "allow" },
      { action: "read", resource: "*", effect: "ask" },
      { action: "computer", resource: "*", effect: "deny" },
      { ...deny, extra: true },
      { action: "browser", resource: "*" },
    ])
      for (const scopes of [PHONE, ALL])
        expect({ rule, decision: create({ permissions: [deny, rule] }, scopes) }).toEqual({
          rule,
          decision: { ok: false, status: 403, type: "scope_denied", scope: "local" },
        })
    expect(create({ permissions: deny }).ok).toBe(false)
    expect(create({ permissions: "*" }).ok).toBe(false)
    // The approval modes a phone sets on its new conversation (MUX-15): all three with `prompt`, never computer use.
    for (const mode of ["ask", "read-only", "full"])
      expect(Policy.rpc(OwnAccounts.ID, "session.approval.set", { sessionID: "s", mode }, PHONE, "local").ok).toBe(true)
    expect(
      Policy.rpc(OwnAccounts.ID, "session.approval.set", { sessionID: "s", mode: "ask", computerUse: "on" }, PHONE, "local").ok,
    ).toBe(false)
  })

  test("a hand-over copies exactly its source's rules, which the relay reads first (RL5-4)", () => {
    const rules = [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "bash", resource: "*", effect: "ask" },
    ]
    const body = (permissions: unknown, seededFrom: unknown = "ses_src") => ({
      title: "인계",
      permissions,
      metadata: { own: { seededFrom } },
    })
    const match = Policy.classify("POST", "/api/session")
    const decide = (value: unknown) => Policy.decide({ need: match.need, params: match.params, scopes: PHONE, server: "local", body: value })
    // The decision lets the relay read the source; without a source named, rules of its own are refused.
    expect(decide(body(rules)).ok).toBe(true)
    expect(decide(body(rules, 7)).ok).toBe(false)
    expect(decide({ permissions: rules }).ok).toBe(false)
    expect(decide(body([{ action: "computer", resource: "*", effect: "allow" }])).ok).toBe(false)
    expect(Policy.handoffSource(body(rules))).toBe("ses_src")
    // A body with no rules of its own needs no read.
    expect(Policy.handoffSource(body([]))).toBeUndefined()
    expect(Policy.handoffSource(body(undefined))).toBeUndefined()
    const source = (permissions?: unknown) => ({ data: { id: "ses_src", ...(permissions ? { permissions } : {}) } })
    expect(Policy.handedOver(body(rules), source(rules))).toBe(true)
    // Rule for rule and in order: one more, one less, another effect or another order is refused.
    expect(Policy.handedOver(body([...rules, { action: "edit", resource: "*", effect: "allow" }]), source(rules))).toBe(false)
    expect(Policy.handedOver(body(rules.slice(0, 1)), source(rules))).toBe(false)
    expect(Policy.handedOver(body([rules[0], { ...rules[1], effect: "allow" }]), source(rules))).toBe(false)
    expect(Policy.handedOver(body([...rules].reverse()), source(rules))).toBe(false)
    expect(Policy.handedOver(body(rules), source())).toBe(false)
    // A source that allows computer use, or could not be read, is refused (as a fork).
    const computer = [{ action: "computer", resource: "*", effect: "allow" }]
    expect(Policy.handedOver(body(computer), source(computer))).toBe(false)
    expect(Policy.handedOver(body(rules), undefined)).toBe(false)
    expect(Policy.handedOver(body(rules), { type: "session_not_found" })).toBe(false)
  })

  test("a device fork needs prompt, and a readable source session whose rules do not allow computer use", () => {
    const match = Policy.classify("POST", "/api/session/ses_1/fork")
    expect(match.need).toEqual({ kind: "session-fork" })
    expect(Policy.needsBody(match.need)).toBe(false)
    expect(Policy.decide({ need: match.need, params: match.params, scopes: PHONE, server: "local" }).ok).toBe(true)
    expect(Policy.decide({ need: match.need, params: match.params, scopes: READ, server: "local" })).toMatchObject({
      ok: false,
      scope: "prompt",
    })
    const source = (permissions?: unknown) => ({ data: { id: "ses_1", ...(permissions ? { permissions } : {}) } })
    expect(Policy.forkable(source())).toBe(true)
    expect(Policy.forkable(source([{ action: "browser", resource: "*", effect: "deny" }]))).toBe(true)
    expect(Policy.forkable(source([{ action: "computer", resource: "*", effect: "deny" }]))).toBe(true)
    expect(Policy.forkable(source([{ action: "computer", resource: "*", effect: "allow" }]))).toBe(false)
    expect(Policy.forkable(source([{ action: "*", resource: "*", effect: "allow" }]))).toBe(false)
    // The source could not be read (unknown session, upstream error): fail closed.
    expect(Policy.forkable(undefined)).toBe(false)
    expect(Policy.forkable({ type: "session_not_found" })).toBe(false)
  })

  test("a device's new child names its parent, which the relay reads like a fork's source", () => {
    expect(Policy.parentOf({ parentID: "ses_pc", title: "child" })).toBe("ses_pc")
    expect(Policy.parentOf({ title: "plain" })).toBeUndefined()
    expect(Policy.parentOf({ parentID: 7 })).toBeUndefined()
    expect(Policy.parentOf(undefined)).toBeUndefined()
  })

  test("a device form reply needs prompt and never carries the computer-use allow answer", () => {
    const match = Policy.classify("POST", "/api/session/ses_1/form/frm_1/reply")
    expect(match.need).toEqual({ kind: "form-reply" })
    expect(Policy.needsBody(match.need)).toBe(true)
    const reply = (answer: unknown, scopes: ReadonlySet<string> = PHONE) =>
      Policy.decide({ need: match.need, params: match.params, scopes, server: "local", body: { answer } })
    expect(reply({ q0: "거부 · Deny" }).ok).toBe(true)
    expect(reply({ q0: "Yes", q1: ["a", "b"] }).ok).toBe(true)
    expect(reply({ q0: "Yes" }, READ)).toMatchObject({ ok: false, scope: "prompt" })
    // Chosen or typed as a custom answer, alone or in a list: the gate would grant the app.
    expect(reply({ q0: OwnComputer.ALLOW_ANSWER })).toMatchObject({ ok: false, scope: "local" })
    expect(reply({ q0: "Yes", q1: [OwnComputer.ALLOW_ANSWER] })).toMatchObject({ ok: false, scope: "local" })
  })

  test("a device prompt needs prompt, is read up to 4 MiB and carries the device stamp (06 §2.9)", () => {
    const match = Policy.classify("POST", "/api/session/ses_1/prompt")
    expect(match.need).toEqual({ kind: "prompt" })
    expect(Policy.needsBody(match.need)).toBe(true)
    expect(Policy.bodyLimit(match)).toBe(4 * 1024 * 1024)
    expect(Policy.bodyLimit(Policy.classify("POST", "/api/session/ses_1/command"))).toBe(Policy.BODY_LIMIT)
    expect(Policy.decide({ need: match.need, params: match.params, scopes: PHONE, server: "host" }).ok).toBe(true)
    expect(Policy.decide({ need: match.need, params: match.params, scopes: READ, server: "local" })).toMatchObject({
      ok: false,
      scope: "prompt",
    })
    // The client's own value is replaced, the other metadata keys stay, the scopes are sorted.
    const body = {
      text: "응",
      metadata: { [OwnRemote.DEVICE_META]: { scopes: ["admin", "local"] }, "own.dictation": true },
    }
    expect(Policy.stamp(body, new Set(["switch", "read", "prompt"]))).toEqual({
      text: "응",
      metadata: { [OwnRemote.DEVICE_META]: { scopes: ["prompt", "read", "switch"] }, "own.dictation": true },
    })
    expect(Policy.stamp({ text: "a" }, new Set(["admin", "read"]))).toEqual({
      text: "a",
      metadata: { [OwnRemote.DEVICE_META]: { scopes: ["admin", "read"] } },
    })
    expect(Policy.stamp({ text: "a", metadata: "x" }, PHONE)).toEqual({
      text: "a",
      metadata: { [OwnRemote.DEVICE_META]: { scopes: ["prompt", "read", "switch"] } },
    })
    // Not an object: upstream refuses it as it is.
    expect(Policy.stamp([1], PHONE)).toEqual([1])
    expect(Policy.stamp("text", PHONE)).toBe("text")
  })

  test("a device write needs files and lands only inside the server's temp folder", () => {
    const match = Policy.classify("POST", "/api/experimental/fs/write")
    expect(match.need).toEqual({ kind: "fs-write" })
    expect(Policy.needsBody(match.need)).toBe(false)
    expect(Policy.decide({ need: match.need, params: [], scopes: PHONE, server: "local" })).toMatchObject({
      ok: false,
      scope: "files",
    })
    const windows = { paths: { tmp: "C:\\Users\\me\\AppData\\Local\\Temp\\opencode" } }
    const writable = (target: string | string[], info: unknown = windows) =>
      Policy.tmpWritable(Array.isArray(target) ? target : [target], info)
    // own-web's attachment uploads and staged git inputs, with either separator and any case.
    expect(writable("C:\\Users\\me\\AppData\\Local\\Temp\\opencode/uploads/u1/photo.png")).toBe(true)
    expect(writable("c:/users/me/appdata/local/temp/opencode/own-git/k1-msg.txt")).toBe(true)
    // Outside it: a Startup folder, a git hook, a config; relative to the Location; climbing out with `..`.
    expect(writable("C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\a.cmd")).toBe(
      false,
    )
    expect(writable("D:\\repo\\.git\\hooks\\pre-commit")).toBe(false)
    expect(writable(".opencode/opencode.jsonc")).toBe(false)
    expect(writable("C:\\Users\\me\\AppData\\Local\\Temp\\opencode\\..\\evil.cmd")).toBe(false)
    expect(writable("C:\\Users\\me\\AppData\\Local\\Temp\\opencode\\uploads\\.. \\x")).toBe(false)
    expect(writable("C:\\Users\\me\\AppData\\Local\\Temp\\opencode")).toBe(false)
    expect(writable("C:\\Users\\me\\AppData\\Local\\Temp\\opencode-other\\x")).toBe(false)
    // Windows path forms that name something else: an alternate data stream, device and UNC paths, root-relative.
    expect(writable("C:\\Users\\me\\AppData\\Local\\Temp\\opencode\\x.txt:stream")).toBe(false)
    expect(writable("\\\\?\\C:\\Users\\me\\AppData\\Local\\Temp\\opencode\\x")).toBe(false)
    expect(writable("\\\\server\\share\\x")).toBe(false)
    expect(writable("\\Users\\me\\AppData\\Local\\Temp\\opencode\\x")).toBe(false)
    // One path only (a repeated query would leave the choice to the server), and a readable temp folder.
    expect(writable(["C:\\Users\\me\\AppData\\Local\\Temp\\opencode\\x", "C:\\Windows\\x"])).toBe(false)
    expect(writable([])).toBe(false)
    expect(writable("C:\\Users\\me\\AppData\\Local\\Temp\\opencode\\x", null)).toBe(false)
    // A POSIX server (an SSH host).
    const posix = { paths: { tmp: "/tmp/opencode" } }
    expect(writable("/tmp/opencode/uploads/u1/a.png", posix)).toBe(true)
    expect(writable("/tmp/opencode/../../home/me/.bashrc", posix)).toBe(false)
    expect(writable("/home/me/.bashrc", posix)).toBe(false)
    expect(writable("uploads/a.png", posix)).toBe(false)
  })
})

describe("plugin RPC through the protocol tables", () => {
  const rpc = (
    rpcID: string,
    method: string,
    input: unknown,
    scopes: ReadonlySet<string>,
    server: "local" | "host" = "local",
  ) =>
    Policy.decide({
      need: { kind: "rpc" },
      params: [rpcID, method],
      scopes,
      server,
      body: { input },
    }).ok

  test("own.accounts: every method follows OwnAccounts.MethodScope; local never", () => {
    for (const [method, scope] of Object.entries(OwnAccounts.MethodScope)) {
      if (scope === "local") {
        expect({ method, ok: rpc(OwnAccounts.ID, method, {}, ALL) }).toEqual({ method, ok: false })
        continue
      }
      expect({ method, ok: rpc(OwnAccounts.ID, method, {}, new Set([scope])) }).toEqual({ method, ok: true })
      const others = new Set(OwnRemote.DEVICE_SCOPES.filter((item) => item !== scope))
      expect({ method, ok: rpc(OwnAccounts.ID, method, {}, others) }).toEqual({ method, ok: false })
    }
    expect(rpc(OwnAccounts.ID, "switch.estimate", {}, READ)).toBe(false)
    expect(rpc(OwnAccounts.ID, "no.such.method", {}, ALL)).toBe(false)
  })

  test("own.accounts: voice input (02 §3.9) — transcribe needs prompt, the key is local, a host gets none of it", () => {
    const input = { audio: "AAAA", mediaType: "audio/webm" }
    expect(rpc(OwnAccounts.ID, "voice.get", {}, READ)).toBe(true)
    expect(rpc(OwnAccounts.ID, "voice.transcribe", input, READ)).toBe(false)
    expect(rpc(OwnAccounts.ID, "voice.transcribe", input, new Set(["prompt"]))).toBe(true)
    expect(rpc(OwnAccounts.ID, "voice.transcribe", input, new Set(["switch", "admin", "files"]))).toBe(false)
    expect(rpc(OwnAccounts.ID, "voice.set", { enabled: true }, new Set(["admin"]))).toBe(true)
    expect(rpc(OwnAccounts.ID, "voice.key.set", { provider: "openai", key: "sk-fake" }, ALL)).toBe(false)
    for (const method of ["voice.get", "voice.set", "voice.transcribe"])
      expect({ method, ok: rpc(OwnAccounts.ID, method, input, ALL, "host") }).toEqual({ method, ok: false })
    // Besides notes.put (1 MiB, below), only the recording's method reads past 64 KiB, and only up to the voice cap.
    const limit = (route: string) => Policy.bodyLimit(Policy.classify("POST", route))
    const own = (method: string) => `/api/rpc/${OwnAccounts.ID}/${encodeURIComponent(method)}`
    expect(limit(own("voice.transcribe"))).toBe(Policy.VOICE_BODY_LIMIT)
    expect(Policy.VOICE_BODY_LIMIT).toBeGreaterThan(Voice.MAX_AUDIO_BASE64)
    expect(Policy.VOICE_BODY_LIMIT).toBeLessThan(8 * 1024 * 1024)
    for (const method of ["voice.get", "voice.set", "switch.apply"]) expect(limit(own(method))).toBe(Policy.BODY_LIMIT)
    expect(limit("/api/rpc/own.remote/voice.transcribe")).toBe(Policy.BODY_LIMIT)
    expect(limit("/api/session/ses_1/permission/per_1/reply")).toBe(Policy.BODY_LIMIT)
  })

  test("own.accounts: the web search keys (02 §9.2) — read shows the state, the key is local, a host gets neither", () => {
    expect(rpc(OwnAccounts.ID, "websearch.key.get", {}, READ)).toBe(true)
    expect(rpc(OwnAccounts.ID, "websearch.key.set", { service: "brave", key: "BSAfake" }, ALL)).toBe(false)
    for (const method of ["websearch.key.get", "websearch.key.set"])
      expect({ method, ok: rpc(OwnAccounts.ID, method, {}, ALL, "host") }).toEqual({ method, ok: false })
  })

  test("own.accounts: a session's speed is read like its preset and set like ultra (02 §4.8)", () => {
    const set = { sessionID: "s1", speed: "fast" }
    expect(rpc(OwnAccounts.ID, "session.speed.get", { sessionID: "s1" }, READ)).toBe(true)
    expect(rpc(OwnAccounts.ID, "session.speed.set", set, READ)).toBe(false)
    expect(rpc(OwnAccounts.ID, "session.speed.set", set, new Set(["switch"]))).toBe(true)
    // The Claude subscription's usage-credit consent rides on the same switch scope, like `session.preset.consent`.
    expect(rpc(OwnAccounts.ID, "session.speed.set", { ...set, consent: true }, new Set(["switch"]))).toBe(true)
    expect(rpc(OwnAccounts.ID, "session.speed.set", { ...set, consent: true }, new Set(["prompt"]))).toBe(false)
  })

  test("own.accounts: workspace notes are read with read and written with prompt (02 §9.2)", () => {
    const input = { workspace: Notes.workspaceKey({ directory: "D:/work/repo" }), id: "n1" }
    for (const method of ["notes.list", "notes.get"]) {
      expect({ method, ok: rpc(OwnAccounts.ID, method, input, READ) }).toEqual({ method, ok: true })
      expect({ method, ok: rpc(OwnAccounts.ID, method, input, new Set(["prompt"])) }).toEqual({ method, ok: false })
    }
    for (const method of ["notes.put", "notes.remove"]) {
      expect({ method, ok: rpc(OwnAccounts.ID, method, input, READ) }).toEqual({ method, ok: false })
      expect({ method, ok: rpc(OwnAccounts.ID, method, input, new Set(["prompt"])) }).toEqual({ method, ok: true })
      const others = new Set(["read", "switch", "files", "terminal", "admin"])
      expect({ method, ok: rpc(OwnAccounts.ID, method, input, others) }).toEqual({ method, ok: false })
    }
  })

  test("own.accounts: idea notes are listed with read and written with prompt, bodies at 64 KiB (02 §9.2)", () => {
    const input = { id: "i1", text: "아이디어", baseRev: 0 }
    expect(rpc(OwnAccounts.ID, "ideas.list", {}, READ)).toBe(true)
    expect(rpc(OwnAccounts.ID, "ideas.list", {}, new Set(["prompt"]))).toBe(false)
    for (const method of ["ideas.put", "ideas.remove"]) {
      expect({ method, ok: rpc(OwnAccounts.ID, method, input, READ) }).toEqual({ method, ok: false })
      expect({ method, ok: rpc(OwnAccounts.ID, method, input, new Set(["prompt"])) }).toEqual({ method, ok: true })
      const others = new Set(["read", "switch", "files", "terminal", "admin"])
      expect({ method, ok: rpc(OwnAccounts.ID, method, input, others) }).toEqual({ method, ok: false })
      const limit = Policy.bodyLimit(Policy.classify("POST", `/api/rpc/${OwnAccounts.ID}/${method}`))
      expect({ method, limit }).toEqual({ method, limit: 64 * 1024 })
    }
  })

  test("only notes.put is read up to 1 MiB, enough for a whole note of Hangul; other bodies stay at 64 KiB", () => {
    const limit = (method: string, route: string) => Policy.bodyLimit(Policy.classify(method, route))
    expect(limit("POST", `/api/rpc/${OwnAccounts.ID}/notes.put`)).toBe(Policy.NOTES_BODY_LIMIT)
    for (const [method, route] of [
      ["POST", `/api/rpc/${OwnAccounts.ID}/notes.get`],
      ["POST", `/api/rpc/${OwnAccounts.ID}/accounts.update`],
      ["POST", `/api/rpc/${OwnRemote.ID}/notes.put`],
      ["POST", "/api/session"],
      ["PATCH", "/api/session/s1"],
    ])
      expect({ route, limit: limit(method!, route!) }).toEqual({ route, limit: 64 * 1024 })
    const fullest = {
      input: {
        workspace: `local:/${"가".repeat(Notes.WORKSPACE_MAX - 7)}`,
        id: "x".repeat(64),
        title: "가".repeat(Notes.TITLE_MAX),
        text: "가".repeat(Notes.TEXT_MAX),
        baseRev: 123456,
      },
    }
    expect(new TextEncoder().encode(JSON.stringify(fullest)).byteLength).toBeLessThan(Policy.NOTES_BODY_LIMIT)
  })

  test("own.accounts: a device may turn computer use off but never on", () => {
    const set = (computerUse?: string) => ({ sessionID: "s1", mode: "ask", ...(computerUse ? { computerUse } : {}) })
    expect(rpc(OwnAccounts.ID, "session.approval.set", set(), ALL)).toBe(true)
    expect(rpc(OwnAccounts.ID, "session.approval.set", set("off"), ALL)).toBe(true)
    expect(rpc(OwnAccounts.ID, "session.approval.set", set("on"), ALL)).toBe(false)
  })

  test("own.accounts: a prompt device picks a conversation's mode (MUX-15) and turns its browser tool on (MBR), no other switch", () => {
    const prompt = new Set(["read", "prompt", "switch"])
    const set = (mode: string, extra: Record<string, unknown> = {}) => ({ sessionID: "s1", mode, ...extra })
    expect(rpc(OwnAccounts.ID, "session.approval.set", set("ask"), prompt)).toBe(true)
    expect(rpc(OwnAccounts.ID, "session.approval.set", set("read-only"), prompt)).toBe(true)
    expect(rpc(OwnAccounts.ID, "session.approval.set", set("full"), prompt)).toBe(true)
    // The browser tool on (05 §8.10.5): what a device's new conversation gets anyway while the desktop app runs.
    expect(rpc(OwnAccounts.ID, "session.approval.set", set("ask", { browserTool: "on" }), prompt)).toBe(true)
    expect(rpc(OwnAccounts.ID, "session.approval.set", set("ask", { browserTool: "on" }), READ)).toBe(false)
    // Anything else beside the mode (the tool off, computer use, a field the schema would refuse) needs `admin`.
    expect(rpc(OwnAccounts.ID, "session.approval.set", set("ask", { browserTool: "off" }), prompt)).toBe(false)
    expect(rpc(OwnAccounts.ID, "session.approval.set", set("ask", { browserTool: "on", computerUse: "on" }), prompt)).toBe(false)
    expect(rpc(OwnAccounts.ID, "session.approval.set", set("ask", { computerUse: "off" }), prompt)).toBe(false)
    expect(rpc(OwnAccounts.ID, "session.approval.set", set("ask", { extra: 1 }), prompt)).toBe(false)
    expect(rpc(OwnAccounts.ID, "session.approval.set", set("ask"), READ)).toBe(false)
    expect(rpc(OwnAccounts.ID, "session.approval.set", set("full"), ALL)).toBe(true)
  })

  test("own.accounts: what only own.team passes never comes from a device (teamOp, a binding's team)", () => {
    const op = "op_01JB0000000000000000000001"
    const target = { providerID: "own-codex-aaaa", id: "gpt-6-sol" }
    for (const method of ["switch.estimate", "switch.apply", "switch.schedule"]) {
      expect(rpc(OwnAccounts.ID, method, { sessionID: "s1", target }, ALL)).toBe(true)
      expect(rpc(OwnAccounts.ID, method, { sessionID: "s1", target, teamOp: op }, ALL)).toBe(false)
    }
    const apply = { sessionID: "s1", presetID: "builtin:codex" }
    expect(rpc(OwnAccounts.ID, "session.preset.apply", apply, ALL)).toBe(true)
    expect(rpc(OwnAccounts.ID, "session.preset.apply", { ...apply, team: null }, ALL)).toBe(false)
    const team = { teamID: "tm_0123456789ab", role: "owner", accounts: [], pinned: [] }
    expect(rpc(OwnAccounts.ID, "session.preset.apply", { ...apply, team }, ALL)).toBe(false)
  })

  test("own.computer: a device that can prompt or switch sees the status and presses Stop, and nothing else", () => {
    for (const scope of ["prompt", "switch"]) {
      expect(rpc(OwnComputer.ID, "status", {}, new Set([scope]))).toBe(true)
      expect(rpc(OwnComputer.ID, "killswitch.engage", {}, new Set([scope]))).toBe(true)
    }
    const watcher = new Set(OwnRemote.DEVICE_SCOPES.filter((scope) => scope !== "prompt" && scope !== "switch"))
    expect(rpc(OwnComputer.ID, "status", {}, watcher)).toBe(false)
    expect(rpc(OwnComputer.ID, "killswitch.engage", {}, watcher)).toBe(false)
    // Allowing it again, the grants, the helper and the audit log stay on the PC; a remote host has no computer use.
    for (const method of Object.keys(OwnComputer.MethodScope).filter((name) => !Policy.COMPUTER_METHODS.has(name)))
      expect({ method, ok: rpc(OwnComputer.ID, method, {}, ALL) }).toEqual({ method, ok: false })
    expect(rpc(OwnComputer.ID, "killswitch.engage", {}, ALL, "host")).toBe(false)
    expect(rpc(OwnComputer.ID, "no.such.method", {}, ALL)).toBe(false)
  })

  test("own.remote: read/drive/manage ↔ read/switch/admin; local and agent.* never; connect{hostKeyPrompt} is local", () => {
    for (const method of Object.keys(OwnRemote.MethodScope) as OwnRemote.MethodName[]) {
      const scope = OwnRemote.MethodScope[method]
      const needed = scope === "read" ? "read" : scope === "drive" ? "switch" : scope === "manage" ? "admin" : undefined
      expect({ method, ok: rpc(OwnRemote.ID, method, {}, ALL) }).toEqual({ method, ok: needed !== undefined })
      if (needed) expect({ method, ok: rpc(OwnRemote.ID, method, {}, new Set([needed])) }).toEqual({ method, ok: true })
    }
    for (const method of ["devices.list", "devices.pair.start", "gateway.status", "gateway.disable", "resolve"])
      expect(rpc(OwnRemote.ID, method, {}, ALL)).toBe(false)
    expect(rpc(OwnRemote.ID, "connect", { hostId: "h-abcdef", clientId: "c" }, new Set(["admin"]))).toBe(true)
    expect(rpc(OwnRemote.ID, "connect", { hostId: "h-abcdef", clientId: "c", hostKeyPrompt: true }, ALL)).toBe(false)
    // On a remote server (`/srv/<hostId>`) own.remote is agent-only: always blocked (04 §12.7).
    expect(rpc(OwnRemote.ID, "agent.broker.arm", {}, ALL, "host")).toBe(false)
    expect(rpc(OwnRemote.ID, "hosts.list", {}, ALL, "host")).toBe(false)
    expect(rpc("other.plugin", "x", {}, ALL)).toBe(false)
  })

  const rpcDecision = (
    rpcID: string,
    method: string,
    scopes: ReadonlySet<string>,
    server: "local" | "host" = "local",
  ) => Policy.decide({ need: { kind: "rpc" }, params: [rpcID, method], scopes, server, body: { input: {} } })
  const decision = (method: string, scopes: ReadonlySet<string>, server: "local" | "host" = "local") =>
    rpcDecision(OwnTeamRouting.ID, method, scopes, server)
  const importDecision = (method: string, scopes: ReadonlySet<string>, server: "local" | "host" = "local") =>
    rpcDecision(OwnImportRouting.ID, method, scopes, server)

  test("own.team: every method follows OwnTeamRouting.MethodScope; local never (06 §2.7)", () => {
    const methods = Object.entries(OwnTeamRouting.MethodScope)
    expect(methods.length).toBeGreaterThan(30)
    for (const [method, scope] of methods) {
      if (scope === "local") {
        expect({ method, decision: decision(method, ALL) }).toEqual({
          method,
          decision: { ok: false, status: 403, type: "scope_denied", scope: "local" },
        })
        continue
      }
      expect({ method, ok: decision(method, new Set([scope])).ok }).toEqual({ method, ok: true })
      const others = new Set(OwnRemote.DEVICE_SCOPES.filter((item) => item !== scope))
      expect({ method, decision: decision(method, others) }).toEqual({
        method,
        decision: { ok: false, status: 403, type: "scope_denied", scope },
      })
    }
    expect(decision("no.such.method", ALL)).toMatchObject({ ok: false, scope: "unknown" })
    expect(decision("", ALL)).toMatchObject({ ok: false, scope: "unknown" })
  })

  test("own.team per scope class: a default phone reads, pauses and switches; admin and local stay off it", () => {
    // read
    for (const method of ["health", "team.get", "team.list", "op.get", "outbox.list", "diagnostics"])
      expect({ method, ok: decision(method, READ).ok }).toEqual({ method, ok: true })
    // prompt (Main 멈춤, owner-conversation actions) and switch (area main, area preset, team account)
    for (const method of ["team.pause", "area.pause", "outbox.cancel", "area.rotate", "area.paths"]) {
      expect({ method, ok: decision(method, PHONE).ok }).toEqual({ method, ok: true })
      expect({ method, ok: decision(method, READ).ok }).toEqual({ method, ok: false })
    }
    for (const method of ["area.main", "area.preset", "team.account"]) {
      expect({ method, ok: decision(method, PHONE).ok }).toEqual({ method, ok: true })
      expect({ method, ok: decision(method, new Set(["read", "prompt"])).ok }).toEqual({ method, ok: false })
    }
    // admin: enabling, reorganizing, integrating
    for (const method of ["enable", "disable", "op.undo", "reorg.apply", "area.integrate"]) {
      expect({ method, decision: decision(method, PHONE) }).toEqual({
        method,
        decision: { ok: false, status: 403, type: "scope_denied", scope: "admin" },
      })
      expect({ method, ok: decision(method, new Set(["admin"])).ok }).toEqual({ method, ok: true })
    }
    // local: confirms of destructive steps, push, settings writes; no scope set reaches them
    for (const method of ["op.confirm", "integration.push.plan", "integration.push.execute", "settings.set"])
      expect({ method, ok: decision(method, ALL).ok }).toEqual({ method, ok: false })
  })

  test("own.team on a remote server (/srv/<hostId>) follows the same table; local methods stay off every device (TG17)", () => {
    for (const [method, scope] of Object.entries(OwnTeamRouting.MethodScope)) {
      // Exactly this PC's decision, for every scope set a device can hold.
      for (const scopes of [ALL, PHONE, READ, new Set([scope])])
        expect({ method, decision: decision(method, scopes, "host") }).toEqual({
          method,
          decision: decision(method, scopes),
        })
      if (scope === "local") {
        expect({ method, decision: decision(method, ALL, "host") }).toEqual({
          method,
          decision: { ok: false, status: 403, type: "scope_denied", scope: "local" },
        })
        continue
      }
      expect({ method, ok: decision(method, new Set([scope]), "host").ok }).toEqual({ method, ok: true })
      const others = new Set(OwnRemote.DEVICE_SCOPES.filter((item) => item !== scope))
      expect({ method, decision: decision(method, others, "host") }).toEqual({
        method,
        decision: { ok: false, status: 403, type: "scope_denied", scope },
      })
    }
    // Confirms, push and settings writes: 403 local whatever the device holds.
    for (const method of ["op.confirm", "integration.push.plan", "integration.push.execute", "settings.set"])
      expect({ method, decision: decision(method, ALL, "host") }).toEqual({
        method,
        decision: { ok: false, status: 403, type: "scope_denied", scope: "local" },
      })
    expect(decision("area.pause", PHONE, "host").ok).toBe(true)
    expect(decision("team.get", READ, "host").ok).toBe(true)
    expect(decision("reorg.apply", PHONE, "host")).toMatchObject({ ok: false, scope: "admin" })
    expect(decision("no.such.method", ALL, "host")).toMatchObject({ ok: false, scope: "unknown" })
    expect(decision("", ALL, "host")).toMatchObject({ ok: false, scope: "unknown" })
  })

  test("own.computer on a remote server stays refused; this PC keeps status + Stop", () => {
    for (const method of [...Object.keys(OwnComputer.MethodScope), "no.such.method"])
      expect({ method, decision: rpcDecision(OwnComputer.ID, method, ALL, "host") }).toEqual({
        method,
        decision: { ok: false, status: 403, type: "scope_denied", scope: "remote" },
      })
    expect(rpc(OwnComputer.ID, "status", {}, PHONE)).toBe(true)
    expect(rpc(OwnComputer.ID, "killswitch.engage", {}, PHONE)).toBe(true)
    expect(rpc(OwnComputer.ID, "killswitch.reset", {}, ALL)).toBe(false)
  })

  test("the own.computer rule is unchanged next to own.team: status and Stop only", () => {
    expect([...Policy.COMPUTER_METHODS].sort()).toEqual(["killswitch.engage", "status"])
    for (const method of Object.keys(OwnComputer.MethodScope))
      expect({ method, ok: rpc(OwnComputer.ID, method, {}, ALL) }).toEqual({
        method,
        ok: Policy.COMPUTER_METHODS.has(method),
      })
    // own.team names no computer-use method, and a computer-use field in its input changes nothing.
    expect(Object.keys(OwnTeamRouting.MethodScope).filter((method) => /computer/i.test(method))).toEqual([])
    expect(rpc(OwnTeamRouting.ID, "area.main", { areaID: "a1", model: null, computerUse: "on" }, PHONE)).toBe(true)
    expect(rpc(OwnTeamRouting.ID, "settings.set", { teamID: "t1", patch: { computerUse: "on" } }, ALL)).toBe(false)
  })

  // The generic own.import tests read its table and never count its methods; the IG11 tests below pin the I2 values.
  test("own.import: every method follows OwnImportRouting.MethodScope on this PC; local and unknown never (09 §5.5)", () => {
    expect(OwnImportRouting.ID).toBe("own.import")
    const methods = Object.entries(OwnImportRouting.MethodScope)
    expect(methods.length).toBeGreaterThan(0)
    for (const [method, scope] of methods) {
      if (scope === "local") {
        expect({ method, decision: importDecision(method, ALL) }).toEqual({
          method,
          decision: { ok: false, status: 403, type: "scope_denied", scope: "local" },
        })
        continue
      }
      expect({ method, ok: importDecision(method, new Set([scope])).ok }).toEqual({ method, ok: true })
      const others = new Set(OwnRemote.DEVICE_SCOPES.filter((item) => item !== scope))
      expect({ method, decision: importDecision(method, others) }).toEqual({
        method,
        decision: { ok: false, status: 403, type: "scope_denied", scope },
      })
    }
    // Names outside the table, inherited properties included, are refused whatever the device holds.
    for (const method of ["no.such.method", "toString", "__proto__", "constructor", ""])
      expect({ method, decision: importDecision(method, ALL) }).toEqual({
        method,
        decision: { ok: false, status: 403, type: "scope_denied", scope: "unknown" },
      })
  })

  // 09 §5.5 I2 (Q2, decided 2026-10-08): health, the views and jobs.list need read, the migration prompt, the roots
  // setting stays local. Opened once the view answers redact secrets (own-import, IMP.20).
  const IMPORT_READ = ["health", "sources.list", "sessions.list", "sessions.read", "sessions.search", "jobs.list"]
  const IMPORT_MIGRATION = ["migrate.plan", "migrate.execute", "migrate.cancel"]

  test("IG11: a device without read gets no own.import view; a read device lists, reads and searches", () => {
    const noRead = new Set(OwnRemote.DEVICE_SCOPES.filter((item) => item !== "read"))
    for (const method of IMPORT_READ) {
      expect({ method, decision: importDecision(method, noRead) }).toEqual({
        method,
        decision: { ok: false, status: 403, type: "scope_denied", scope: "read" },
      })
      for (const scopes of [READ, PHONE, ALL])
        expect({ method, ok: importDecision(method, scopes).ok }).toEqual({ method, ok: true })
    }
    // Read alone does not migrate (and nothing configures the roots, below).
    for (const method of IMPORT_MIGRATION)
      expect({ method, decision: importDecision(method, READ) }).toEqual({
        method,
        decision: { ok: false, status: 403, type: "scope_denied", scope: "prompt" },
      })
  })

  test("IG11: a prompt device plans, executes and cancels; without prompt it cannot", () => {
    const PROMPT = new Set(["prompt"])
    const noPrompt = new Set(OwnRemote.DEVICE_SCOPES.filter((item) => item !== "prompt"))
    for (const method of IMPORT_MIGRATION) {
      for (const scopes of [PROMPT, PHONE, ALL])
        expect({ method, ok: importDecision(method, scopes).ok }).toEqual({ method, ok: true })
      expect({ method, decision: importDecision(method, noPrompt) }).toEqual({
        method,
        decision: { ok: false, status: 403, type: "scope_denied", scope: "prompt" },
      })
    }
    // Prompt alone does not read: the list and the viewer stay closed to it.
    expect(importDecision("sessions.list", PROMPT)).toMatchObject({ ok: false, scope: "read" })
  })

  test("IG11: a device reaches own's project folders only and always hides secrets in an import (09 §5.5, IG10)", () => {
    const ask = (method: string, input: unknown) =>
      Policy.decide({
        need: { kind: "rpc" },
        params: [OwnImportRouting.ID, method],
        scopes: ALL,
        server: "local",
        body: { input },
      })
    const ref = { kind: "codex", rootID: "codex-default", id: "thread-1" }
    const folder = { directory: "D:\\work\\app" }
    expect(ask("sessions.list", folder).ok).toBe(true)
    expect(ask("sessions.list", { ...folder, scope: "folder" }).ok).toBe(true)
    expect(ask("sessions.read", { ...folder, ref }).ok).toBe(true)
    expect(ask("migrate.plan", { ...folder, ref, redact: true }).ok).toBe(true)
    for (const method of ["sessions.list", "sessions.read", "sessions.search", "migrate.plan"])
      expect({ method, decision: ask(method, { ...folder, ref, scope: "all" }) }).toEqual({
        method,
        decision: { ok: false, status: 403, type: "scope_denied", scope: "local" },
      })
    expect(ask("migrate.plan", { ...folder, ref, redact: false })).toMatchObject({ ok: false, scope: "local" })
  })

  test("SK2: a device lists skills and opens a detail, but never sends a link approval (approvedLinks is this PC's)", () => {
    const ask = (method: string, input: unknown) =>
      Policy.decide({
        need: { kind: "rpc" },
        params: [OwnImportRouting.ID, method],
        scopes: ALL,
        server: "local",
        body: { input },
      })
    const links = ["lk-0123456789abcdef0123"]
    expect(ask("skills.list", {}).ok).toBe(true)
    expect(ask("skills.list", { hashes: true, directory: "D:\\work\\app" }).ok).toBe(true)
    expect(ask("skills.detail", { key: "sk-0123456789abcdef" }).ok).toBe(true)
    for (const [method, input] of [
      ["skills.list", { approvedLinks: links }],
      ["skills.detail", { key: "sk-0123456789abcdef", approvedLinks: links }],
    ] as const)
      expect({ method, decision: ask(method, input) }).toEqual({
        method,
        decision: { ok: false, status: 403, type: "scope_denied", scope: "local" },
      })
  })

  test("IG11: sources.configure is refused from every device, whatever it holds", () => {
    for (const scopes of [ALL, PHONE, READ, ...OwnRemote.DEVICE_SCOPES.map((item) => new Set([item]))])
      expect({ scopes: [...scopes], decision: importDecision("sources.configure", scopes) }).toEqual({
        scopes: [...scopes],
        decision: { ok: false, status: 403, type: "scope_denied", scope: "local" },
      })
  })

  test("IG11 through the route: the decided methods pass, percent-encoded names too; the roots setting never", () => {
    const call = (route: string, scopes: ReadonlySet<string>) => {
      const match = Policy.classify("POST", route)
      return Policy.decide({ need: match.need, params: match.params, scopes, server: "local", body: { input: {} } })
    }
    expect(call("/api/rpc/own.import/health", READ).ok).toBe(true)
    expect(call("/api/rpc/own.import/sessions%2Elist", READ).ok).toBe(true)
    expect(call("/api/rpc/own.import/sessions.read", READ).ok).toBe(true)
    expect(call("/api/rpc/own.import/migrate.execute", READ)).toMatchObject({ ok: false, scope: "prompt" })
    expect(call("/api/rpc/own.import/migrate%2Eexecute", PHONE).ok).toBe(true)
    expect(call("/api/rpc/own.import/sources%2Econfigure", ALL)).toMatchObject({ ok: false, scope: "local" })
  })

  test("own.import on a remote server (/srv/<hostId>) is refused for every method and device: not on a host in v1", () => {
    for (const method of [...Object.keys(OwnImportRouting.MethodScope), "no.such.method"])
      for (const scopes of [ALL, PHONE, READ])
        expect({ method, decision: importDecision(method, scopes, "host") }).toEqual({
          method,
          decision: { ok: false, status: 403, type: "scope_denied", scope: "remote" },
        })
    // The same health call passes on this PC.
    expect(importDecision("health", READ).ok).toBe(true)
  })

  test("own.harness: read views, a switch needs switch like a model switch; the same on a remote host (10 §6.1)", () => {
    const harness = (method: string, scopes: ReadonlySet<string>, server: "local" | "host" = "local") =>
      rpcDecision(OwnHarness.ID, method, scopes, server)
    for (const server of ["local", "host"] as const) {
      for (const [method, scope] of Object.entries(OwnHarness.MethodScope)) {
        // A setting of the server itself (compaction.set) is this PC's: no device passes it.
        if (scope === "local") {
          expect({ method, server, decision: harness(method, ALL, server) }).toEqual({
            method,
            server,
            decision: { ok: false, status: 403, type: "scope_denied", scope: "local" },
          })
          continue
        }
        const needed = scope === "drive" ? "switch" : scope
        expect({ method, server, ok: harness(method, ALL, server).ok }).toEqual({ method, server, ok: true })
        expect({ method, server, ok: harness(method, new Set([needed]), server).ok }).toEqual({ method, server, ok: true })
        const without = new Set(OwnRemote.DEVICE_SCOPES.filter((item) => item !== needed))
        expect({ method, server, decision: harness(method, without, server) }).toEqual({
          method,
          server,
          decision: { ok: false, status: 403, type: "scope_denied", scope: needed },
        })
      }
      // A default phone (read, prompt, switch) sees the pill and switches; a read-only device only sees it.
      expect(harness("list", READ, server).ok).toBe(true)
      expect(harness("session.get", READ, server).ok).toBe(true)
      expect(harness("session.set", READ, server).ok).toBe(false)
      expect(harness("session.set", new Set(["read", "prompt"]), server).ok).toBe(false)
      expect(harness("session.set", PHONE, server).ok).toBe(true)
      expect(harness("no.such.method", ALL, server)).toMatchObject({ ok: false, scope: "unknown" })
      expect(harness("toString", ALL, server)).toMatchObject({ ok: false, scope: "unknown" })
    }
    const call = (route: string, scopes: ReadonlySet<string>) => {
      const match = Policy.classify("POST", route)
      return Policy.decide({ need: match.need, params: match.params, scopes, server: "host", body: { input: {} } })
    }
    expect(call("/api/rpc/own.harness/session%2Eset", PHONE).ok).toBe(true)
    expect(call("/api/rpc/own.harness/session.set", READ)).toMatchObject({ ok: false, scope: "switch" })
  })

  test("an app-listener device (kind 'app', 08 §3.5) gets the same decisions as a browser with its scopes", async () => {
    const ownHome = fs.mkdtempSync(path.join(os.tmpdir(), "own-policy-app-"))
    try {
      const store = new Devices.Store({ ownHome })
      const pair = (kind: OwnRemote.DeviceKind) =>
        store.create({
          deviceId: Devices.newDeviceId(),
          name: kind,
          kind,
          scopes: ["read", "prompt"],
          servers: { mode: "all" },
          expiresDays: 30,
          userAgent: kind === "app" ? "OwnOpenCodeApp/1 (android) Android/15" : null,
          ip: null,
        })
      const app = await pair("app")
      const browser = await pair("browser")
      const verified = await store.verify(app.token)
      if (!verified.ok) throw new Error(verified.reason)
      expect(verified.device.kind).toBe("app")
      const scopes = new Set(verified.device.scopes)
      for (const method of Object.keys(OwnTeamRouting.MethodScope))
        for (const server of ["local", "host"] as const)
          expect({ method, server, decision: decision(method, scopes, server) }).toEqual({
            method,
            server,
            decision: decision(method, new Set(browser.record.scopes), server),
          })
      for (const server of ["local", "host"] as const) {
        expect(decision("area.pause", scopes, server).ok).toBe(true)
        expect(decision("area.main", scopes, server)).toMatchObject({ ok: false, scope: "switch" })
        expect(decision("op.confirm", scopes, server)).toMatchObject({ ok: false, scope: "local" })
        expect(decision("settings.set", scopes, server)).toMatchObject({ ok: false, scope: "local" })
      }
      for (const method of Object.keys(OwnImportRouting.MethodScope))
        for (const server of ["local", "host"] as const)
          expect({ method, server, decision: importDecision(method, scopes, server) }).toEqual({
            method,
            server,
            decision: importDecision(method, new Set(browser.record.scopes), server),
          })
      // The computer-use rule holds for app devices too: Stop on this PC, nothing on a host.
      expect(rpc(OwnComputer.ID, "killswitch.engage", {}, scopes)).toBe(true)
      expect(rpc(OwnComputer.ID, "killswitch.reset", {}, scopes)).toBe(false)
      expect(rpc(OwnComputer.ID, "killswitch.engage", {}, scopes, "host")).toBe(false)
      // A host's team events reach the app device exactly like a browser's, by its servers.
      const confirm = `data: ${JSON.stringify({ id: "e1", type: "rpc.own.team.op.confirm", data: { teamID: "t1" } })}`
      expect(Policy.frameVisible(confirm, verified.device.servers)).toBe(
        Policy.frameVisible(confirm, browser.record.servers),
      )
    } finally {
      fs.rmSync(ownHome, { recursive: true, force: true })
    }
  })
})

describe("event stream filter (05 §13.4 2)", () => {
  const all = { mode: "all" } as const
  const frame = (type: string, data: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id: "e1", type, data })}`

  test("local own.remote events and unknown plugin events are dropped; the rest passes", () => {
    expect(Policy.frameVisible(frame("session.created", { sessionID: "s1" }), all)).toBe(true)
    expect(Policy.frameVisible(": heartbeat", all)).toBe(true)
    expect(Policy.frameVisible(frame("rpc.own.accounts.quota.updated"), all)).toBe(true)
    expect(Policy.frameVisible(frame("rpc.own.remote.host.prompt", { hostId: "h-abcdef" }), all)).toBe(false)
    expect(Policy.frameVisible(frame("rpc.own.remote.device.pairing.pending", { sas: "1234" }), all)).toBe(false)
    expect(Policy.frameVisible(frame("rpc.own.remote.device.pairing.ended"), all)).toBe(false)
    expect(Policy.frameVisible(frame("rpc.own.remote.hosts.changed"), all)).toBe(true)
    expect(Policy.frameVisible(frame("rpc.other.thing"), all)).toBe(false)
    expect(Policy.frameVisible(frame("rpc.own.remote.not.declared"), all)).toBe(false)
    expect(Policy.frameVisible("data: {not json", all)).toBe(false)
  })

  test("declared own.team events pass (team view, notices, op progress); undeclared ones are dropped", () => {
    for (const name of Object.keys(OwnTeamRouting.EventOrigin))
      expect({ name, ok: Policy.frameVisible(frame(`rpc.own.team.${name}`, { teamID: "t1" }), all) }).toEqual({
        name,
        ok: true,
      })
    expect(
      Policy.frameVisible(frame("rpc.own.team.notice", { teamID: "t1", kind: "rotation.done", text: "x" }), all),
    ).toBe(true)
    expect(Policy.frameVisible(frame("rpc.own.team.not.declared"), all)).toBe(false)
    expect(Policy.frameVisible(frame("rpc.own.teams.changed"), all)).toBe(false)
  })

  test("own.import events pass when its table declares them read; undeclared names are dropped (09 §5.3)", () => {
    const events = Object.entries(OwnImportRouting.EventScope)
    expect(events.length).toBeGreaterThan(0)
    const localOnly = { mode: "only", keys: ["local"] } as const
    for (const [name, scope] of events)
      for (const servers of [all, localOnly])
        expect({ name, ok: Policy.frameVisible(frame(`rpc.own.import.${name}`), servers) }).toEqual({
          name,
          ok: scope === "read",
        })
    // IG11: the 09 §5.3 events reach devices, so a phone follows the list and a running migration. No payload filter:
    // they carry no conversation content, only folders, job ids and session ids.
    for (const type of ["rpc.own.import.index.changed", "rpc.own.import.job.progress", "rpc.own.import.job.finished"])
      expect({ type, ok: Policy.frameVisible(frame(type), localOnly) }).toEqual({ type, ok: true })
    expect(Policy.frameVisible(frame("rpc.own.import.index.changed", { directories: ["D:\\work\\app"] }), all)).toBe(
      true,
    )
    expect(
      Policy.frameVisible(
        frame("rpc.own.import.job.finished", { jobID: "j1", outcome: "succeeded", sessionID: "ses_1" }),
        all,
      ),
    ).toBe(true)
    for (const type of [
      "rpc.own.import.not.declared",
      "rpc.own.import.toString",
      "rpc.own.import.",
      "rpc.own.imports.index.changed",
    ])
      expect({ type, ok: Policy.frameVisible(frame(type), all) }).toEqual({ type, ok: false })
  })

  test("declared own.harness events pass like session events; undeclared names are dropped (10 §6.1)", () => {
    const localOnly = { mode: "only", keys: ["local"] } as const
    const names = Object.keys(OwnHarness.Definition.events)
    expect(names).toEqual(["session.changed"])
    for (const servers of [all, localOnly])
      expect(
        Policy.frameVisible(
          frame("rpc.own.harness.session.changed", { sessionID: "ses_1", harness: "opencode", previous: "codex" }),
          servers,
        ),
      ).toBe(true)
    for (const type of [
      "rpc.own.harness.not.declared",
      "rpc.own.harness.toString",
      "rpc.own.harness.",
      "rpc.own.harnesses.session.changed",
    ])
      expect({ type, ok: Policy.frameVisible(frame(type), all) }).toEqual({ type, ok: false })
  })

  test("a host's own.team events reach only devices that may see that host (/srv/<hostId>/api/event)", () => {
    const only = { mode: "only", keys: ["local", "h-aaaaaa"] } as const
    const localOnly = { mode: "only", keys: ["local"] } as const
    // The route refuses a device whose servers lack the host before it relays anything (gateway.test.ts: 403).
    expect(Policy.serverAllowed(only, "h-aaaaaa")).toBe(true)
    expect(Policy.serverAllowed(all, "h-bbbbbb")).toBe(true)
    expect(Policy.serverAllowed(only, "h-bbbbbb")).toBe(false)
    expect(Policy.serverAllowed(localOnly, "h-aaaaaa")).toBe(false)
    // Relayed, a host's team events pass the frame filter as this PC's do; undeclared ones stay out.
    for (const name of Object.keys(OwnTeamRouting.EventOrigin))
      expect({ name, ok: Policy.frameVisible(frame(`rpc.own.team.${name}`, { teamID: "t1" }), only) }).toEqual({
        name,
        ok: true,
      })
    expect(Policy.frameVisible(frame("rpc.own.team.not.declared"), all)).toBe(false)
  })

  test("host events outside the device's servers are dropped", () => {
    const only = { mode: "only", keys: ["local", "h-aaaaaa"] } as const
    expect(Policy.frameVisible(frame("rpc.own.remote.host.state", { hostId: "h-aaaaaa" }), only)).toBe(true)
    expect(Policy.frameVisible(frame("rpc.own.remote.host.state", { hostId: "h-bbbbbb" }), only)).toBe(false)
    expect(Policy.frameVisible(frame("rpc.own.remote.feed.item", { item: { serverKey: "h-bbbbbb" } }), only)).toBe(
      false,
    )
    expect(Policy.frameVisible(frame("rpc.own.remote.feed.item", { item: { serverKey: "local" } }), only)).toBe(true)
  })
})

describe("the browser pane on a device (05 §8.10)", () => {
  const all = { mode: "all" } as const
  const view = (scopes: ReadonlyArray<string>, serverKey = "local", servers: OwnRemote.ServerScope = all) =>
    Policy.browserView({ scopes: new Set(scopes), servers, serverKey })

  test("the viewer socket needs browser and read, the server allowed, and this PC", () => {
    expect(view(["read", "browser"])).toEqual({ ok: true })
    expect(view(OwnRemote.DEVICE_SCOPES)).toEqual({ ok: true })
    // The missing scope is named, `browser` first; no other scope stands in for it.
    expect(view(["read"])).toEqual({ ok: false, status: 403, type: "scope_denied", scope: "browser" })
    expect(view([])).toMatchObject({ ok: false, status: 403, scope: "browser" })
    expect(view(["browser"])).toEqual({ ok: false, status: 403, type: "scope_denied", scope: "read" })
    expect(view(OwnRemote.DEVICE_SCOPES.filter((scope) => scope !== "browser"))).toMatchObject({ ok: false, scope: "browser" })
    expect(view(OwnRemote.DEVICE_SCOPES.filter((scope) => scope !== "read"))).toMatchObject({ ok: false, scope: "read" })
    expect([...PHONE]).not.toContain("browser")
    expect(view([...PHONE])).toMatchObject({ ok: false, scope: "browser" })
    // A host's sessions have no pane on this PC: not here, for a device that may see the host; not allowed otherwise.
    expect(view(["read", "browser"], "h-abcdef")).toEqual({ ok: false, status: 404, type: "browser_unavailable" })
    const hostOnly = { mode: "only", keys: ["h-abcdef"] } as const
    expect(view(["read", "browser"], "h-abcdef", hostOnly)).toMatchObject({ ok: false, status: 404 })
    expect(view(["read", "browser"], "local", hostOnly)).toEqual({ ok: false, status: 403, type: "scope_denied", scope: "server" })
    expect(view(["read", "browser"], "h-zzzzzz", hostOnly)).toMatchObject({ ok: false, status: 403, scope: "server" })
    expect(view(["read", "browser"], "local", { mode: "only", keys: ["local"] })).toEqual({ ok: true })
    // The scope decides before the server does: a device without it learns nothing about servers.
    expect(view(["read"], "h-abcdef")).toMatchObject({ ok: false, status: 403, scope: "browser" })
  })

  test("the viewer socket is the gateway's own route: the relay's allow list and its sockets are as they were", () => {
    expect(Policy.ROUTES.some(([, template]) => template.includes("browser"))).toBe(false)
    expect(Policy.WEBSOCKET_ROUTES).toEqual(["/api/pty/:ptyID/connect", "/api/experimental/persistent-pty/:ptyID/connect"])
    expect(Policy.classify("GET", "/own/browser/local/ses_1").need).toEqual({ kind: "blocked", reason: "not_allowlisted" })
    expect(Policy.classify("GET", "/api/browser/ses_1").need).toEqual({ kind: "blocked", reason: "not_allowlisted" })
    // `browser` opens nothing on the relay: every route decides as it does without it, and alone it passes none.
    const without = new Set(OwnRemote.DEVICE_SCOPES.filter((scope) => scope !== "browser"))
    for (const [method, template] of Policy.ROUTES) {
      const match = Policy.classify(method, template.replace(/:\w+/g, "x1").replace("*", "a"))
      if (match.need.kind === "rpc") continue
      const decide = (scopes: ReadonlySet<string>) =>
        Policy.decide({ need: match.need, params: match.params, scopes, server: "local", body: {} }).ok
      expect({ template, alone: decide(new Set(["browser"])), same: decide(ALL) === decide(without) }).toEqual({
        template,
        alone: false,
        same: true,
      })
    }
  })

  test("the shell's and the window's methods are local; a device reads browser.status only, and core's browser RPC never", () => {
    const local = ["browser.host.pull", "browser.host.frame", "browser.host.state", "browser.host.result", "browser.pane.wanted"]
    for (const method of local) {
      expect(OwnRemote.MethodScope[method as OwnRemote.MethodName]).toBe("local")
      expect({ method, decision: Policy.rpc(OwnRemote.ID, method, {}, ALL, "local") }).toEqual({
        method,
        decision: { ok: false, status: 403, type: "scope_denied", scope: "local" },
      })
    }
    expect(Policy.rpc(OwnRemote.ID, "browser.status", {}, READ, "local")).toEqual({ ok: true })
    expect(Policy.rpc(OwnRemote.ID, "browser.status", {}, new Set(["browser", "prompt"]), "local")).toMatchObject({
      ok: false,
      scope: "read",
    })
    expect(Policy.rpc(OwnRemote.ID, "browser.status", {}, ALL, "host")).toMatchObject({ ok: false, scope: "remote" })
    expect(Policy.rpc("experimental.browser", "tabs.list", {}, ALL, "local")).toMatchObject({ ok: false, scope: "unknown_rpc" })
    // The event that asks the window for a pane, and core's browser events, never reach a device.
    const frame = (type: string, data: Record<string, unknown> = {}) => `data: ${JSON.stringify({ id: "e1", type, data })}`
    expect(OwnRemote.EventScope["browser.pane.wanted"]).toBe("local")
    expect(Policy.frameVisible(frame("rpc.own.remote.browser.pane.wanted", { sessionID: "ses_1" }), all)).toBe(false)
    expect(Policy.frameVisible(frame("rpc.experimental.browser.attached", { sessionID: "ses_1" }), all)).toBe(false)
  })

  test("a prompt's stamp names browser like any scope a device holds", () => {
    expect(Policy.stamp({ text: "a" }, ALL)).toEqual({
      text: "a",
      metadata: { [OwnRemote.DEVICE_META]: { scopes: ["admin", "browser", "files", "prompt", "read", "switch", "terminal"] } },
    })
  })

  test("browserRemoved reads rules as core does: the last rule matching `browser` is a `*` deny", () => {
    const deny = { action: "browser", resource: "*", effect: "deny" }
    const allow = { action: "browser", resource: "*", effect: "allow" }
    expect(Policy.browserRemoved([deny])).toBe(true)
    expect(
      Policy.browserRemoved([{ action: "edit", resource: "*", effect: "deny" }, deny, { action: "bash", resource: "*", effect: "ask" }]),
    ).toBe(true)
    // The desktop attachment's allow after it wins; a deny after the allow takes it away again.
    expect(Policy.browserRemoved([deny, allow])).toBe(false)
    expect(Policy.browserRemoved([allow, deny])).toBe(true)
    // Wildcards and case as in core (`*`, `?`, `name *`).
    expect(Policy.browserRemoved([{ action: "*", resource: "*", effect: "deny" }])).toBe(true)
    expect(Policy.browserRemoved([{ action: "Brow?er", resource: "*", effect: "deny" }])).toBe(true)
    expect(Policy.browserRemoved([{ action: "browser *", resource: "*", effect: "deny" }])).toBe(true)
    expect(Policy.browserRemoved([deny, { action: "*", resource: "*", effect: "allow" }])).toBe(false)
    // Only a deny of everything removes the tools: a narrower one, an ask or another action does not.
    expect(Policy.browserRemoved([{ action: "browser", resource: "https://example.com/*", effect: "deny" }])).toBe(false)
    expect(Policy.browserRemoved([{ action: "browser", resource: "*", effect: "ask" }])).toBe(false)
    expect(Policy.browserRemoved([{ action: "browsers", resource: "*", effect: "deny" }])).toBe(false)
    expect(Policy.browserRemoved([{ action: "computer", resource: "*", effect: "deny" }])).toBe(false)
    for (const rules of [undefined, null, [], "browser", {}, [null, 7, "x"]]) expect(Policy.browserRemoved(rules)).toBe(false)
  })

  test("paneAttachable: a session that was read and keeps the browser", () => {
    const deny = { action: "browser", resource: "*", effect: "deny" }
    expect(Policy.paneAttachable({ data: { id: "ses_1" } })).toBe(true)
    expect(Policy.paneAttachable({ data: { id: "ses_1", permissions: [] } })).toBe(true)
    expect(Policy.paneAttachable({ data: { id: "ses_1", permissions: [{ action: "edit", resource: "*", effect: "deny" }] } })).toBe(true)
    expect(Policy.paneAttachable({ data: { id: "ses_1", permissions: [deny] } })).toBe(false)
    // Not read (404, another shape): nothing is asked of the window.
    for (const source of [undefined, null, {}, { type: "session_not_found" }, { data: null }, { data: "x" }])
      expect(Policy.paneAttachable(source)).toBe(false)
  })

  test("the wildcard's `name *` form also counts for computer use: such an allow is still refused from a device", () => {
    const create = (permissions: unknown) => {
      const match = Policy.classify("POST", "/api/session")
      return Policy.decide({ need: match.need, params: match.params, scopes: ALL, server: "local", body: { permissions } })
    }
    expect(create([{ action: "computer *", resource: "*", effect: "allow" }])).toMatchObject({ ok: false, scope: "local" })
    expect(Policy.forkable({ data: { permissions: [{ action: "computer *", resource: "*", effect: "allow" }] } })).toBe(false)
    expect(Policy.forkable({ data: { permissions: [{ action: "computers", resource: "*", effect: "allow" }] } })).toBe(true)
  })
})
