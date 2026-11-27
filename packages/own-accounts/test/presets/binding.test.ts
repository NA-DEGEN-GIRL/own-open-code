// Root-session preset binding (07 §5.1, §3.3; T0 part): driven through the switching module's `session.created`
// handling with the fake session core of the switching harness, and `PresetBinding.ensure` on its own for the ★ and
// the remote service. Groups are the subagent gate's (`presets.groupOf`). Every account is fake.

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { Kv, Preset } from "@own/protocol"
import type { Modules } from "../../src/modules.js"
import type { Plugins } from "../../src/plugins/plugins.js"
import { PresetBinding } from "../../src/presets/binding.js"
import { Presets } from "../../src/presets/presets.js"
import type { RemoteHost } from "../../src/remote/host.js"
import type { Variant } from "../../src/switching/variant.js"
import { testDeps } from "../support/deps.js"
import { machine } from "../switching/harness.js"
import { PROVIDERS, noClaudeAgent, partial } from "../switching/support.js"

const CODEX = { providerID: PROVIDERS.codexA, id: "gpt-5.6-sol", variant: "high" }
const CLAUDE = { providerID: "anthropic", id: "claude-opus-5-5" }
const decode = Schema.decodeUnknownSync(Preset.Binding)

/** `session.created` as core publishes it; `parentID` makes a child session. */
function created(sessionID: string, model?: Variant.Ref, parentID?: string) {
  return {
    sessionID,
    ...(model ? { model } : {}),
    ...(parentID ? { parentID } : {}),
    projectID: "p",
    slug: "s",
    version: "2",
    location: {},
  }
}

describe("root sessions (07 §5.1)", () => {
  test("a ChatGPT session is bound to the group's 평소대로 and nothing else changes", async () => {
    await using m = await machine()
    await m.send("session.created", created("ses_root", CODEX))
    await m.flush()
    expect<unknown>(decode(m.kv.get(Kv.preset("ses_root")))).toEqual({
      presetID: "builtin:codex",
      group: "codex",
      revision: 0,
      appliedAt: m.clock.now(),
      entryHash: null,
    })
    expect(m.kv.get(Kv.home("ses_root"))).toMatchObject({ providerID: PROVIDERS.codexA, pinned: false })
    // The main stays the session's Ref (PG12): no switch, no permission write, no prompt; `평소대로` has no entry.
    expect(m.calls.switchModel).toEqual([])
    expect(m.calls.update).toEqual([])
    expect(m.calls.prompt).toEqual([])
    expect(m.events("binding.changed")).toEqual([])
  })

  test("a session created without a model is bound after the pin, to the pinned account's group", async () => {
    const configured = { providerID: PROVIDERS.oaiA, id: "gpt-5.5" }
    await using m = await machine({
      defaultModel: configured,
      available: [{ providerID: PROVIDERS.codexA, id: "gpt-5.6-sol" }],
    })
    await m.send("session.created", created("ses_new"))
    await m.flush()
    expect(m.calls.switchModel).toEqual([{ sessionID: "ses_new", model: configured }])
    expect(decode(m.kv.get(Kv.preset("ses_new")))).toMatchObject({ presetID: "builtin:oai", group: "oai" })
  })

  test("a stored binding is never replaced, even one this build cannot decode", async () => {
    const applied = Preset.ID.create()
    const stored = {
      presetID: applied,
      group: "codex",
      revision: 4,
      appliedAt: 1,
      entryHash: "h1",
      team: { teamID: "tm_1", role: "owner", accounts: [], pinned: [] },
    }
    const newer = { presetID: "team:later", group: "codex" }
    await using m = await machine({
      kv: [
        [Kv.preset("ses_applied"), stored],
        [Kv.preset("ses_newer"), newer],
      ],
    })
    await m.send("session.created", created("ses_applied", CODEX))
    await m.send("session.created", created("ses_newer", CODEX))
    await m.flush()
    expect(m.kv.get(Kv.preset("ses_applied"))).toEqual(stored)
    expect(m.kv.get(Kv.preset("ses_newer"))).toEqual(newer)
  })

  test("a child session gets no binding and no pin: it follows its root's (07 §2.8)", async () => {
    await using m = await machine()
    await m.send("session.created", created("ses_root", CODEX))
    await m.send("session.created", created("ses_child", CODEX, "ses_root"))
    await m.send("session.created", created("ses_bare_child", undefined, "ses_root"))
    await m.flush()
    expect(m.kv.has(Kv.preset("ses_child"))).toBe(false)
    expect(m.kv.has(Kv.preset("ses_bare_child"))).toBe(false)
    expect(m.calls.switchModel).toEqual([])
    expect(decode(m.kv.get(Kv.preset("ses_root"))).presetID).toBe(Preset.builtinID("codex"))
  })
})

const CLAUDE_SLOT = { detected: true, version: "1.0.0", integrity: "sha512-x", verified: true }

describe("groups (07 P-D2)", () => {
  test("the Claude slot binds to claude-sub, a discovered Ollama model to local:ollama", async () => {
    await using m = await machine({ claude: CLAUDE_SLOT })
    await m.send("session.created", created("ses_claude", CLAUDE))
    await m.send("session.created", created("ses_ollama", { providerID: "ollama", id: "qwen3-coder:30b" }))
    await m.flush()
    expect(decode(m.kv.get(Kv.preset("ses_claude")))).toMatchObject({
      presetID: "builtin:claude-sub",
      group: "claude-sub",
    })
    expect(decode(m.kv.get(Kv.preset("ses_ollama")))).toMatchObject({
      presetID: "builtin:local:ollama",
      group: "local:ollama",
    })
  })

  test("a provider outside every group gets no binding, Anthropic without the Claude slot too", async () => {
    await using m = await machine()
    await m.send("session.created", created("ses_builtin", { providerID: "openai", id: "gpt-5.5" }))
    await m.send("session.created", created("ses_vllm", { providerID: "vllm", id: "qwen3" }))
    // An Anthropic API key: the gate sees no group for it, so no claude-sub preset may apply (07 §5.4, R4).
    await m.send("session.created", created("ses_anthropic_key", CLAUDE))
    await m.flush()
    expect(m.kv.has(Kv.preset("ses_builtin"))).toBe(false)
    expect(m.kv.has(Kv.preset("ses_vllm"))).toBe(false)
    expect(m.kv.has(Kv.preset("ses_anthropic_key"))).toBe(false)
  })
})

describe("PresetBinding.ensure", () => {
  test("binds to the group's ★ from the presets store; a remote service always binds 평소대로; only KV is touched", async () => {
    const recorder = recording()
    // The strict test context throws on any member but `storage`: no session call, no other host API.
    await using t = await testDeps({ ctx: { storage: recorder.storage } })
    const star = Preset.ID.create()
    await t.deps.runtime.presets.write({
      version: 1,
      groups: { "claude-sub": { star, presets: [{ ...Preset.builtin("claude-sub"), id: star, name: "Claude 리뷰" }] } },
    })
    // The real presets module (★ from presets.json, the gate's groups) over the installed Claude slot.
    const presetsOf = async (deps: typeof t.deps) => {
      const plugins = partial<Plugins.Api>("plugins", { claudeSlot: () => CLAUDE_SLOT })
      const presets = Presets.create(deps, () => peers)
      const peers = partial<Modules.All>("modules", { plugins, presets, claudeAgent: noClaudeAgent() })
      await presets.start()
      return { peers: () => peers, presets }
    }
    const local = await presetsOf(t.deps)
    await PresetBinding.ensure(t.deps, local.peers, "ses_local", CLAUDE)
    const remoteDeps = { ...t.deps, remote: partial<RemoteHost.Api>("remote", { claudeAgent: () => undefined }) }
    const remote = await presetsOf(remoteDeps)
    await PresetBinding.ensure(remoteDeps, remote.peers, "ses_remote", CLAUDE)
    await local.presets.stop()
    await remote.presets.stop()
    expect(decode(recorder.values.get(Kv.preset("ses_local"))).presetID).toBe(star)
    expect(decode(recorder.values.get(Kv.preset("ses_remote"))).presetID).toBe(Preset.builtinID("claude-sub"))
    expect(recorder.calls).toEqual([
      `get ${Kv.preset("ses_local")}`,
      `set ${Kv.preset("ses_local")}`,
      `get ${Kv.preset("ses_remote")}`,
      `set ${Kv.preset("ses_remote")}`,
    ])
  })
})

/** An in-memory own-accounts KV that logs each call. */
function recording() {
  const values = new Map<string, Schema.Json>()
  const calls: string[] = []
  const storage: Pick<StorageDomain, "get" | "set"> = {
    get: async (key) => {
      calls.push(`get ${key}`)
      return values.get(key)
    },
    set: async (key, value) => {
      calls.push(`set ${key}`)
      values.set(key, value)
    },
  }
  return { storage, values, calls }
}
