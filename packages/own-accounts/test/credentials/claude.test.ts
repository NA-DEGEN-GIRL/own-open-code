// plugin.claudeAuth.importSubscription (02 §8.2 step 6): checks the Claude slot state, then runs the `claude-code`
// OAuth method of integration `anthropic` through the plugin context and reports the active connection.

import { describe, expect, test } from "bun:test"
import { call, harness } from "./support.js"

const time = { created: 0, expires: 60_000 }

function integration(input: { readonly statuses: ReadonlyArray<string>; readonly connections: string[] }) {
  const queue = [...input.statuses]
  return {
    integration: {
      oauth: {
        connect: async (request: {
          readonly integrationID: string
          readonly methodID: string
          readonly answer?: Record<string, unknown>
        }) => {
          input.connections.push(
            `${request.integrationID}/${request.methodID}${request.answer ? ` ${JSON.stringify(request.answer)}` : ""}`,
          )
          return {
            location: { directory: "x" },
            data: { attemptID: "attempt-1", url: "", instructions: "", mode: "auto", time },
          }
        },
        status: async () => ({ location: { directory: "x" }, data: { status: queue.shift() ?? "complete", time } }),
      },
      connection: {
        active: async (integrationID: string) =>
          integrationID === "anthropic" && queue.length === 0
            ? { type: "credential", id: "cred-1", label: "Claude Max · na***@example.test", method: "oauth" }
            : undefined,
      },
    },
  }
}

describe("plugin.claudeAuth.importSubscription", () => {
  test("refuses when the plugin is not loaded; asks no consent (02 §8.4, 2026-10-18)", async () => {
    const connections: string[] = []
    await using missing = await harness({ ctx: integration({ statuses: [], connections }) })
    expect(await call(missing.logins.claudeImport, {})).toMatchObject({ ok: false, type: "plugin_not_installed" })
    expect(connections).toEqual([])
  })

  test("runs the claude-code OAuth method and reports the connection", async () => {
    const connections: string[] = []
    await using h = await harness({
      ctx: integration({ statuses: ["pending", "complete"], connections }),
      claudeSlot: { detected: true, verified: true },
    })
    expect(await call(h.logins.claudeImport, {})).toEqual({
      ok: true,
      output: {
        ok: true,
        connection: { type: "oauth", method: "claude-code", label: "Claude Max · na***@example.test" },
      },
    })
    expect(connections).toEqual(["anthropic/claude-code"])
  })

  test("with several Claude accounts the import names the slot's own account (02 §8.7)", async () => {
    const connections: string[] = []
    await using h = await harness({
      ctx: integration({ statuses: ["complete"], connections }),
      claudeSlot: { detected: true, verified: true },
      claudeKey: "c:/users/me/.claude",
    })
    expect((await call(h.logins.claudeImport, {})).ok).toBe(true)
    expect(connections).toEqual(['anthropic/claude-code {"account":"c:/users/me/.claude"}'])
  })

  test("a failed attempt reports ok false without throwing", async () => {
    await using h = await harness({
      ctx: integration({ statuses: ["failed", "failed"], connections: [] }),
      claudeSlot: { detected: true, verified: true },
    })
    expect(await call(h.logins.claudeImport, {})).toEqual({ ok: true, output: { ok: false, connection: null } })
  })
})
