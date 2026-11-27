// The default "모델 @ 계정" of a new session (03 §5.1, 07 §2.2): the last one used in the folder, skipping own slots
// whose account the server no longer lists (real-host finding, 04 §20.3 RG13: after an account was removed on the PC
// and the host's mirror followed, the host's newest session still named the removed slot and a new session failed on
// it); else the new-session account with its provider group's default model. On an SSH host the Claude slot counts
// only while this PC relays it there (04 §8.11.13). Every account and model is fake.
import { describe, expect, test } from "bun:test"
import type { Plugin } from "@own/protocol"
import type { ServerRuntime } from "@/data"
import { hostServes, newSessionLoading, newSessionTarget } from "./new-session"

type Row = { readonly directory: string; readonly model: { readonly providerID: string; readonly id: string } | null }
type Seed = { readonly providerID: string; readonly status: string; readonly kind?: string }
type Listed = { readonly providerID: string; readonly id: string; readonly released?: number; readonly price?: number }

function runtime(input: {
  readonly rows: ReadonlyArray<[string, Row]>
  readonly accounts: Record<string, Seed>
  readonly status?: string
  readonly groupDefaults?: Record<string, { readonly id: string; readonly variant?: string; readonly source: string }>
  readonly defaultAccounts?: Record<string, string>
  readonly defaultsLoaded?: boolean
  /** `null`: no catalog has answered yet. */
  readonly models?: ReadonlyArray<Listed> | null
  /** An SSH host with its `health.claudeSlot` (04 §8.11); this PC by default. */
  readonly ssh?: { readonly state: Plugin.ClaudeRemoteState | null; readonly conflict: boolean }
}) {
  const byProvider = Object.fromEntries(Object.entries(input.accounts).map(([id, account]) => [account.providerID, id]))
  const accounts = Object.fromEntries(
    Object.entries(input.accounts).map(([id, account]) => [id, { id, kind: "compat", ...account }]),
  )
  const models = input.models === undefined ? [{ providerID: "own-compat-live01", id: "fake" }] : input.models
  return {
    key: "srv-test",
    kind: input.ssh ? "ssh" : "local",
    sessions: { state: { order: input.rows.map(([id]) => id), sessions: Object.fromEntries(input.rows) } },
    own: {
      state: {
        status: input.status ?? "ready",
        accountOrder: Object.keys(accounts),
        accounts,
        accountByProvider: byProvider,
        groupDefaults: input.groupDefaults ?? {},
        defaultAccounts: input.defaultAccounts ?? {},
        defaultsLoaded: input.defaultsLoaded ?? true,
        health: input.ssh ? { claudeSlot: input.ssh } : undefined,
      },
      accountFor: (providerID: string) => (byProvider[providerID] ? accounts[byProvider[providerID]!] : undefined),
    },
    // Catalog-shaped entries (`ModelInfo`), so the group rule can read release dates and prices.
    data: { location: { model: { list: () => models?.map(info) } } },
  } as unknown as ServerRuntime
}

function info(model: Listed) {
  return {
    providerID: model.providerID,
    id: model.id,
    modelID: model.id,
    enabled: true,
    status: "active",
    time: { released: model.released ?? 0 },
    cost: model.price === undefined ? [] : [{ input: model.price, output: model.price, cache: { read: 0, write: 0 } }],
    variants: [],
  }
}

describe("newSessionTarget", () => {
  const rows: ReadonlyArray<[string, Row]> = [
    ["s-new", { directory: "/work/app", model: { providerID: "own-compat-gone01", id: "fake" } }],
    ["s-old", { directory: "/work/app", model: { providerID: "own-compat-live01", id: "fake" } }],
  ]
  const accounts = { acc_live: { providerID: "own-compat-live01", status: "ready" } }

  test("skips an own slot whose account the server no longer lists", () => {
    expect(newSessionTarget(runtime({ rows, accounts }), "srv-test" as never, "/work/app")).toMatchObject({
      providerID: "own-compat-live01",
      id: "fake",
    })
  })

  test("a provider of the server's own config (no account, not an own slot) stays usable", () => {
    const config: ReadonlyArray<[string, Row]> = [
      ["s-cfg", { directory: "/work/app", model: { providerID: "anthropic", id: "claude" } }],
    ]
    expect(newSessionTarget(runtime({ rows: config, accounts }), "srv-test" as never, "/work/app")).toMatchObject({
      providerID: "anthropic",
    })
  })

  test("before the own registry has loaded, the newest session's model is kept (no false negative)", () => {
    expect(
      newSessionTarget(runtime({ rows, accounts: {}, status: "idle" }), "srv-test" as never, "/work/app"),
    ).toMatchObject({
      providerID: "own-compat-gone01",
    })
  })

  test("retired and disabled accounts stay excluded", () => {
    const retired = { acc_gone: { providerID: "own-compat-gone01", status: "retired" }, ...accounts }
    expect(newSessionTarget(runtime({ rows, accounts: retired }), "srv-test" as never, "/work/app")).toMatchObject({
      providerID: "own-compat-live01",
    })
  })
})

describe("newSessionTarget: a folder without sessions (07 §2.2 rule 3)", () => {
  const CODEX_MODELS = [
    { providerID: "own-codex-aaaa", id: "gpt-5.6-sol" },
    { providerID: "own-codex-aaaa", id: "gpt-6-astra" },
    { providerID: "own-codex-bbbb", id: "gpt-5.6-sol" },
    { providerID: "own-codex-bbbb", id: "gpt-6-astra" },
  ]
  const codex = {
    acc_a: { providerID: "own-codex-aaaa", status: "ready", kind: "codex" },
    acc_b: { providerID: "own-codex-bbbb", status: "ready", kind: "codex" },
  }
  const elsewhere: ReadonlyArray<[string, Row]> = [
    ["s-a", { directory: "/work/other", model: { providerID: "own-codex-aaaa", id: "gpt-5.6-sol" } }],
  ]
  const astra = { codex: { id: "gpt-6-astra", variant: "high", source: "auto" } }

  test("starts on the group default of the most recent session's account, not on another folder's model", () => {
    const target = newSessionTarget(
      runtime({ rows: elsewhere, accounts: codex, groupDefaults: astra, models: CODEX_MODELS }),
      "srv-test" as never,
      "/work/new",
    )
    expect(target).toEqual({ providerID: "own-codex-aaaa", id: "gpt-6-astra", variant: "high" })
  })

  test("the kind's default account wins over the recent session's account", () => {
    const target = newSessionTarget(
      runtime({
        rows: elsewhere,
        accounts: codex,
        groupDefaults: astra,
        defaultAccounts: { codex: "acc_b" },
        models: CODEX_MODELS,
      }),
      "srv-test" as never,
      "/work/new",
    )
    expect(target).toEqual({ providerID: "own-codex-bbbb", id: "gpt-6-astra", variant: "high" })
  })

  test("without sessions: the first account that can serve; a default it lacks gives the group rule", () => {
    const accounts = {
      acc_off: { providerID: "own-ds-off1", status: "exhausted", kind: "ds" },
      acc_ds: { providerID: "own-ds-dddd", status: "ready", kind: "ds" },
    }
    // `ds` costs money: the newest model, a tie going to the lower price (07 §2.2), never simply the first listed.
    const models = [
      { providerID: "own-ds-dddd", id: "deepseek-v4-pro", released: 2, price: 1.7 },
      { providerID: "own-ds-dddd", id: "deepseek-flash", released: 2, price: 0.3 },
      { providerID: "own-ds-dddd", id: "deepseek-chat-old", released: 1, price: 0.1 },
    ]
    const missing = { ds: { id: "deepseek-chat", source: "user" } }
    expect(
      newSessionTarget(runtime({ rows: [], accounts, groupDefaults: missing, models }), "srv-test" as never, undefined),
    ).toEqual({ providerID: "own-ds-dddd", id: "deepseek-flash" })
  })

  test("the most recent session's account that cannot serve now yields to the first one that can", () => {
    const accounts = {
      acc_a: { providerID: "own-codex-aaaa", status: "ready", kind: "codex" },
      acc_b: { providerID: "own-codex-bbbb", status: "exhausted", kind: "codex" },
    }
    const recent: ReadonlyArray<[string, Row]> = [
      ["s-b", { directory: "/work/other", model: { providerID: "own-codex-bbbb", id: "gpt-5.6-sol" } }],
    ]
    expect(
      newSessionTarget(
        runtime({ rows: recent, accounts, groupDefaults: astra, models: CODEX_MODELS }),
        "srv-test" as never,
        "/work/new",
      ),
    ).toEqual({ providerID: "own-codex-aaaa", id: "gpt-6-astra", variant: "high" })
  })

  test("nothing is shown until the group defaults have loaded (no first-model guess)", () => {
    expect(
      newSessionTarget(
        runtime({ rows: elsewhere, accounts: codex, defaultsLoaded: false, models: CODEX_MODELS }),
        "srv-test" as never,
        "/work/new",
      ),
    ).toBeUndefined()
  })
})

describe("newSessionLoading: a send before the screen's model is known (RL5-1)", () => {
  const codex = { acc_a: { providerID: "own-codex-aaaa", status: "ready", kind: "codex" } }
  const models = [{ providerID: "own-codex-aaaa", id: "gpt-6-astra" }]

  test("loading while the accounts or the group defaults have not answered", () => {
    expect(newSessionLoading(runtime({ rows: [], accounts: {}, status: "idle" }))).toBe(true)
    expect(newSessionLoading(runtime({ rows: [], accounts: {}, status: "loading" }))).toBe(true)
    expect(newSessionLoading(runtime({ rows: [], accounts: codex, models, defaultsLoaded: false }))).toBe(true)
  })

  test("loading while the catalog of the account it would start on has not answered", () => {
    const target = runtime({ rows: [], accounts: codex, models: null })
    expect(newSessionTarget(target, "srv-test" as never, "/work/new")).toBeUndefined()
    expect(newSessionLoading(target)).toBe(true)
  })

  test("not loading once everything answered: no account is 'add your first account', a model shows", () => {
    expect(newSessionLoading(runtime({ rows: [], accounts: {}, models: null }))).toBe(false)
    expect(newSessionLoading(runtime({ rows: [], accounts: {} }))).toBe(false)
    expect(newSessionLoading(runtime({ rows: [], accounts: codex, models }))).toBe(false)
    expect(newSessionLoading(runtime({ rows: [], accounts: codex, models: [] }))).toBe(false)
    expect(newSessionLoading(runtime({ rows: [], accounts: codex, status: "unavailable" }))).toBe(false)
  })
})

describe("newSessionTarget on an SSH host: the Claude slot (04 §8.11.13)", () => {
  const MODELS = [
    { providerID: "anthropic", id: "claude-opus-5-5" },
    { providerID: "own-codex-aaaa", id: "gpt-6-astra" },
  ]
  // This PC's accounts (an SSH server's store copies them): the Claude slot first in order.
  const accounts = {
    acc_claude_slot: { providerID: "anthropic", status: "ready", kind: "claude-sub" },
    acc_a: { providerID: "own-codex-aaaa", status: "ready", kind: "codex" },
  }
  const defaults = {
    "claude-sub": { id: "claude-opus-5-5", source: "auto" },
    codex: { id: "gpt-6-astra", source: "auto" },
  }
  const claudeBefore: ReadonlyArray<[string, Row]> = [
    ["s-c", { directory: "/work/other", model: { providerID: "anthropic", id: "claude-opus-5-5" } }],
  ]
  const target = (rows: ReadonlyArray<[string, Row]>, ssh?: Parameters<typeof runtime>[0]["ssh"]) =>
    newSessionTarget(
      runtime({ rows, accounts, groupDefaults: defaults, models: MODELS, ...(ssh ? { ssh } : {}) }),
      "srv-test" as never,
      "/work/new",
    )

  test("Claude only while the host's verdict is enabled; otherwise the next account that can serve", () => {
    expect(target(claudeBefore, { state: "enabled", conflict: false })).toEqual({
      providerID: "anthropic",
      id: "claude-opus-5-5",
    })
    for (const state of ["off", "consent", "host_scope", "not_ready", "billing", null] as const)
      expect(target(claudeBefore, { state, conflict: false })).toEqual({
        providerID: "own-codex-aaaa",
        id: "gpt-6-astra",
      })
    // A host with its own Claude login never uses this PC's.
    expect(target(claudeBefore, { state: "enabled", conflict: true })?.providerID).toBe("own-codex-aaaa")
  })

  test("a folder's last Claude session is not reused while the host cannot use the slot", () => {
    const here: ReadonlyArray<[string, Row]> = [
      ["s-c", { directory: "/work/new", model: { providerID: "anthropic", id: "claude-opus-5-5" } }],
    ]
    expect(target(here, { state: "off", conflict: false })?.providerID).toBe("own-codex-aaaa")
    expect(target(here, { state: "enabled", conflict: false })?.providerID).toBe("anthropic")
  })

  test("this PC is unchanged", () => {
    expect(target(claudeBefore)).toEqual({ providerID: "anthropic", id: "claude-opus-5-5" })
  })
})

// MR11-1: a new SSH-host session starts on this PC's default; the host lists it only once its mirror of this PC's
// accounts arrived (its broker may still be connecting). Before, the session was created anyway and its first prompt
// failed with `Model unavailable: own-oai-…/gpt-6.1-terra` (own-web's remote Playwright suite under load).
describe("hostServes", () => {
  const TARGET = { providerID: "own-oai-abcdef", id: "gpt-6.1-terra" }
  const FREE = { providerID: "opencode", id: "big-pickle", enabled: true }
  const SLOT = { ...TARGET, enabled: true }

  /** A server whose folder catalog is `lists[i]` from its i-th read on (the last one stays). */
  function server(kind: "ssh" | "local", lists: ReadonlyArray<ReadonlyArray<typeof SLOT>>) {
    const calls = { sync: 0, list: 0 }
    const runtime = {
      kind,
      data: {
        location: {
          model: {
            sync: async (input: { directory: string }) => {
              expect(input).toEqual({ directory: "/home/me/work/game" })
              calls.sync++
            },
            list: (input: { directory: string }) => {
              expect(input).toEqual({ directory: "/home/me/work/game" })
              return lists[Math.min(calls.list++, lists.length - 1)]
            },
          },
        },
      },
    } as unknown as ServerRuntime
    return { runtime, calls }
  }

  test("this PC never waits and reads nothing", async () => {
    const { runtime, calls } = server("local", [[FREE]])
    expect(await hostServes(runtime, TARGET, "/home/me/work/game")).toBe("served")
    expect(calls).toEqual({ sync: 0, list: 0 })
  })

  test("a host that already lists the model: one read, no wait", async () => {
    const { runtime, calls } = server("ssh", [[FREE, SLOT]])
    const waits: number[] = []
    expect(await hostServes(runtime, TARGET, "/home/me/work/game", { onWait: () => waits.push(1) })).toBe("served")
    expect(calls.sync).toBe(1)
    expect(waits).toEqual([])
  })

  test("a host whose mirror lands later: waits (one notice) until model.updated brings the slot", async () => {
    const { runtime } = server("ssh", [[FREE], [FREE], [FREE, { ...SLOT, enabled: false }], [FREE, SLOT]])
    const waits: number[] = []
    const served = await hostServes(runtime, TARGET, "/home/me/work/game", {
      onWait: () => waits.push(1),
      pollMs: 1,
      timeoutMs: 5_000,
    })
    expect(served).toBe("served")
    expect(waits).toEqual([1])
  })

  test("a host that never lists it: missing after the wait, so no session is created", async () => {
    const { runtime } = server("ssh", [[FREE]])
    expect(await hostServes(runtime, TARGET, "/home/me/work/game", { pollMs: 1, timeoutMs: 30 })).toBe("missing")
  })

  test("the user leaves the screen during the wait: it ends at once with left, before the host lists it (MR12-5)", async () => {
    const { runtime, calls } = server("ssh", [[FREE], [FREE], [FREE], [FREE, SLOT]])
    const screen = { left: false }
    const pending = hostServes(runtime, TARGET, "/home/me/work/game", {
      onWait: () => setTimeout(() => (screen.left = true), 5),
      left: () => screen.left,
      pollMs: 20,
      timeoutMs: 60_000,
    })
    const started = Date.now()
    expect(await pending).toBe("left")
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(calls.list).toBeLessThan(4)
  })

  test("a user who already left is never served, on this PC or a host that lists the model (RL2-L3)", async () => {
    const left = () => true
    expect(await hostServes(server("local", [[FREE]]).runtime, TARGET, "/home/me/work/game", { left })).toBe("left")
    expect(await hostServes(server("ssh", [[FREE, SLOT]]).runtime, TARGET, "/home/me/work/game", { left })).toBe("left")
  })

  test("a user who leaves during the last poll before the host lists it is not served (RL2-L3)", async () => {
    const screen = { left: false }
    const { runtime } = server("ssh", [[FREE], [FREE, SLOT]])
    const served = await hostServes(runtime, TARGET, "/home/me/work/game", {
      // The leave lands while the poll sleeps; the read right after it lists the slot.
      onWait: () => setTimeout(() => (screen.left = true), 1),
      left: () => screen.left,
      pollMs: 30,
      timeoutMs: 5_000,
    })
    expect(served).toBe("left")
  })
})
