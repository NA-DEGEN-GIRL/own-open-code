// `accounts.update{remote}` (04 §8.9, §16.5): the per-account switch the local broker obeys, stored in the registry
// and shown by `accounts.list`; the Claude slot has no such switch.
import { describe, expect, test } from "bun:test"
import { Modules } from "../../src/modules.js"
import type { Plugins } from "../../src/plugins/plugins.js"
import { failure, memoryStorage, registryWith, rpcContext } from "../slots/support.js"
import { testDeps } from "../support/deps.js"

const CLAUDE: Plugins.ClaudeSlot = { detected: true, version: "1.0.0", integrity: "sha512-x", verified: true }

describe("accounts.update{remote}", () => {
  test("deny is stored and listed; allow restores; the Claude slot refuses the field", async () => {
    await using t = await testDeps({
      ctx: {
        provider: { reload: async () => {}, list: async () => [] },
        storage: memoryStorage().storage,
      },
    })
    await t.deps.runtime.registry.write(await registryWith([{ kind: "oai", label: "Key", slug: "keyb" }]))
    const modules = t.modules({
      plugins: (deps, peers) => ({ ...Modules.FACTORIES.plugins(deps, peers), claudeSlot: () => CLAUDE }),
    })
    await modules.slots.start()
    try {
      const account = modules.slots.snapshot().accounts[0]!
      const denied = await modules.slots.update({ accountID: account.id, remote: "deny" }, rpcContext<"accounts.update">())
      expect(failure(denied)).toBeUndefined()
      expect(modules.slots.account(account.id)?.remote).toBe("deny")
      expect((await t.deps.runtime.registry.read()).accounts[0]?.remote).toBe("deny")
      expect(denied).toMatchObject({ account: { remote: "deny" } })
      await modules.slots.update({ accountID: account.id, remote: "allow" }, rpcContext<"accounts.update">())
      expect(modules.slots.account(account.id)?.remote).toBe("allow")
      const claude = await modules.slots.update(
        { accountID: "acc_claude_slot" as never, remote: "deny" },
        rpcContext<"accounts.update">(),
      )
      expect(failure(claude)).toMatchObject({ type: "policy_denied", data: { field: "remote" } })
    } finally {
      await modules.slots.stop()
    }
  })
})
